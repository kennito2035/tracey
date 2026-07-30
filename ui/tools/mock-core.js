#!/usr/bin/env node
'use strict';
/**
 * Stand-in for tracey.exe. Behaviourally identical from the UI's side, because
 * the UI only ever sees config.cfg and status.cfg.
 *
 * Like the real core it rewrites status.cfg continuously (~5x/sec here, 1x/sec in
 * the core) and bumps a `heartbeat` counter, so the UI can tell a live core from a
 * KILLED one: a hard kill never gets to write running=0, so the UI must treat a
 * status.cfg older than ~3 s as "not running". Kill this process to test that.
 *
 *   node tools/mock-core.js              run as the filter (mirrors config.cfg)
 *   node tools/mock-core.js --calibrate  standalone calibration, then exit
 *
 * The filter core also calibrates IN-PROCESS when config.cfg says calibrate=1,
 * which is how the UI does it: stopping and relaunching a uiAccess core costs a
 * UAC prompt each way. Set TRACEY_MOCK_CAL_MS to shorten the window for tests.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function dir() {
  if (process.env.TRACEY_DIR) return process.env.TRACEY_DIR;
  if (process.platform === 'win32') return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Tracey');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Tracey');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tracey');
}

const DIR = dir();
const CONFIG = path.join(DIR, 'config.cfg');
const STATUS = path.join(DIR, 'status.cfg');
const PROFILE = path.join(DIR, 'profile.cfg');

fs.mkdirSync(DIR, { recursive: true });

const state = { running: 1, enabled: 0, fmin: 0.4, beta: 0.02, preset: 2, tremor_hz: 0,
                calibrating: 0, cal_hz: 0, cal_samples: 0, pen: 1 };
let heartbeat = 0;   // increments on every status write, like the real core

/** CAL_SECONDS in tracey.c. Overridable so the contract suite need not wait it out. */
const CAL_MS = Number(process.env.TRACEY_MOCK_CAL_MS || 10000);

function parse(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#' || s[0] === ';') continue;
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim();
  }
  return out;
}

/* Precision matches the REAL core: tracey.c writes status.cfg as "%.4f" fmin
 * and "%.5f" beta. This mock rounded to 3 and 4, the same way the UI used to
 * round config.cfg, so a value that the real product mangled on the round trip
 * survived intact here and the whole suite was blind to it. A mock that is
 * kinder than the core tests a contract nobody speaks. */
function writeStatus() {
  const body =
    '# status.cfg - written by MOCK core\n' +
    `running=${state.running}\n` +
    `enabled=${state.enabled}\n` +
    `fmin=${Number(state.fmin).toFixed(4)}\n` +
    `beta=${Number(state.beta).toFixed(5)}\n` +
    `preset=${state.preset}\n` +
    `tremor_hz=${Number(state.tremor_hz).toFixed(2)}\n` +
    `calibrating=${state.calibrating}\n` +
    `cal_hz=${Number(state.cal_hz).toFixed(2)}\n` +
    `cal_samples=${state.cal_samples}\n` +
    `pen=${state.pen}\n` +
    `heartbeat=${++heartbeat}\n`;
  const tmp = STATUS + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, STATUS);
}

/** The real core saves the calibrated tremor to profile.cfg and reloads it on
 *  the next launch, so the UI's "X.X Hz" readout survives a restart. */
function loadProfile() {
  try {
    const p = parse(fs.readFileSync(PROFILE, 'utf8'));
    if (p.tremor_hz !== undefined) state.tremor_hz = Number(p.tremor_hz) || 0;
    if (p.fmin !== undefined) state.fmin = Number(p.fmin);
    if (p.beta !== undefined) state.beta = Number(p.beta);
  } catch { /* never calibrated */ }
}

let quitRequested = false;
let cfgMtime = 0;
let savedEnabled = 1;

function saveProfile() {
  fs.writeFileSync(PROFILE,
    `fmin=${state.fmin}\nbeta=${state.beta}\npreset=${state.preset}\n` +
    `tremor_hz=${state.cal_hz.toFixed(2)}\n`);
}

/** Measure without stopping, exactly like the real core's calibrate=1 path. */
function startInprocCalibration() {
  state.calibrating = 1;
  state.cal_samples = 0;
  savedEnabled = state.enabled;
  state.enabled = 1;                 // capture is forced on while measuring
  writeStatus();
  console.log(`[mock] in-process calibration for ${CAL_MS}ms…`);
  setTimeout(() => {
    state.cal_samples = 2000;
    state.cal_hz = Number((7.6 + Math.random() * 1.6).toFixed(2));
    state.tremor_hz = state.cal_hz;
    state.fmin = 0.4; state.beta = 0.02; state.preset = 3;
    saveProfile();
    state.enabled = savedEnabled;    // pause state handed back
    state.calibrating = 0;
    writeStatus();
    console.log(`[mock] cal_hz=${state.cal_hz} — filtering resumed`);
  }, CAL_MS);
}

/**
 * Act only when config.cfg actually CHANGES, like the real core, which tracks
 * its last-write time. Re-reading an unchanged file every tick would re-fire the
 * one-shot calibrate=1 forever.
 */
function readConfig() {
  let c;
  try {
    const m = fs.statSync(CONFIG).mtimeMs;
    if (m === cfgMtime) return;
    cfgMtime = m;
    c = parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch { return; /* no config yet */ }

  // Flagged, not returned on: the startup read must still pick up the initial
  // params, and it clears a stale quit straight afterwards.
  if (Number(c.quit)) quitRequested = true;   // quit=1 stops; enabled=0 only pauses
  if (Number(c.calibrate) && !state.calibrating) { startInprocCalibration(); return; }
  if (state.calibrating) return;                          // params are the core's while measuring

  if (c.enabled !== undefined) state.enabled = Number(c.enabled) ? 1 : 0;
  if (c.fmin !== undefined) state.fmin = Number(c.fmin);
  if (c.beta !== undefined) state.beta = Number(c.beta);
  state.preset = 0; // any hand-written config counts as custom, like the real core
}

/** Mirrors the real core's single-instance mutex. */
function anotherInstanceRunning() {
  try {
    return Number(parse(fs.readFileSync(STATUS, 'utf8')).running) === 1;
  } catch { return false; }
}

if (process.argv.includes('--calibrate')) {
  if (anotherInstanceRunning()) {
    // the real core shows a message box here and exits
    console.error('[mock] REFUSED: a filter core is still running. Send quit=1 first.');
    process.exit(2);
  }
  console.log(`[mock] calibrating for ${CAL_MS}ms…`);
  state.running = 1;
  writeStatus();
  let t = 0;
  const tick = setInterval(() => {
    t += 500;
    writeStatus();
    if (t >= CAL_MS) {
      clearInterval(tick);
      state.cal_hz = Number((7.6 + Math.random() * 1.6).toFixed(2));
      state.tremor_hz = state.cal_hz;
      state.preset = 3;
      state.fmin = 0.4;
      state.beta = 0.02;
      saveProfile();
      state.running = 0;
      writeStatus();
      console.log(`[mock] tremor_hz=${state.tremor_hz} — done`);
      process.exit(0);
    }
  }, 500);
} else {
  if (anotherInstanceRunning()) {
    console.error('[mock] mutex: another filter core is already running. Exiting.');
    process.exit(1);
  }
  console.log('[mock] filter core running. Folder:', DIR);
  console.log('[mock] Ctrl+C to stop, or write quit=1 to config.cfg.');
  loadProfile();          // report the calibrated Hz, like the real core
  readConfig();
  quitRequested = false;   // ignore a stale quit left over from a previous run
  writeStatus();
  const stop = () => { state.running = 0; writeStatus(); process.exit(0); };
  setInterval(() => {
    readConfig();
    if (quitRequested) { console.log('[mock] quit=1 received, stopping.'); return stop(); }
    writeStatus();
  }, 200); // ~5x/sec, like the real core
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
