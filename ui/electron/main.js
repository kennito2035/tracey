'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { CoreComms, defaultDir, PRESETS, PARAM_RANGES } = require('./core-comms');

const ASSETS = path.join(__dirname, '..', 'assets');
const PREFS_FILE = path.join(app.getPath('userData'), 'ui-prefs.json');
// Deliberately NOT in ui-prefs.json. loadPrefs() runs inside uiState(), which runs
// on every status push (several times a second) -- parsing a stroke buffer that
// often would burn real CPU for nothing. Pad state is read once at renderer start
// and written only when a stroke ends.
const PAD_FILE = path.join(app.getPath('userData'), 'pad-state.json');

let win = null;
let tray = null;
let core = null;
let quitting = false;
let calibration = null; // { phase, startedAt, timer }

/* ---------------------------------------------------------------- prefs -- */

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; }
}
function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(next, null, 2));
  } catch { /* prefs are a convenience, not a requirement */ }
  return next;
}

/* ------------------------------------------------------------ pad state -- */

/**
 * The scribbles on both pads, kept across a full quit and relaunch.
 *
 * The practice scribble survives until Clear is pressed and the calibration
 * scribble until the next calibration replaces it -- so reopening the app shows
 * what you drew last time instead of an empty pad you have to redo.
 */
function loadPadState() {
  try { return JSON.parse(fs.readFileSync(PAD_FILE, 'utf8')); } catch { return {}; }
}
function savePadState(state) {
  try {
    fs.mkdirSync(path.dirname(PAD_FILE), { recursive: true });
    fs.writeFileSync(PAD_FILE, JSON.stringify(state));
  } catch { /* a lost scribble must never take the app down with it */ }
  return true;
}

/* ------------------------------------------------------------- ui state -- */

/**
 * Pen presence, from the best source available.
 *
 * A running core probes it natively in ~0.65 ms and republishes every second, so
 * plug/unplug shows up in about a second. The UI's own probe costs ~3.3 s of
 * PowerShell, which is why it can only run every 20 s - that is the difference
 * between noticing an unplug in a second and in half a minute. So the core wins
 * whenever it is running and has an opinion.
 */
function tabletState(status) {
  if (status.running && status.pen !== null) {
    const pen = status.pen === 1;
    return { checked: true, pen, ready: pen, flags: null, source: 'core' };
  }
  return { ...core.tablet, source: 'ui' };
}

function uiState() {
  const status = core.readStatus();
  const writable = core.checkWritable();
  return {
    status,
    paths: core.paths(),
    coreInstalled: core.coreInstalled(),
    tablet: tabletState(status),
    writable,
    profile: core.readProfile(),   // what the "Custom" card offers, if anything
    presets: PRESETS,
    ranges: PARAM_RANGES,
    platform: process.platform,
    calibrating: calibration ? calibration.phase : null,
  };
}

/** active = core running and filtering; paused = running, not filtering; off = no core */
function trayState(status) {
  if (!status.present || !status.running) return 'off';
  return status.enabled ? 'active' : 'paused';
}

function push() {
  const s = uiState();
  if (win && !win.isDestroyed()) win.webContents.send('tracey:state', s);
  updateTray(s);
}

/* ----------------------------------------------------------------- tray -- */

function trayImage(state) {
  const img = nativeImage.createEmpty();
  for (const size of [16, 24, 32, 48]) {
    const p = path.join(ASSETS, `tray-${state}-${size}.png`);
    try {
      const rep = nativeImage.createFromPath(p);
      if (!rep.isEmpty()) img.addRepresentation({ scaleFactor: size / 16, buffer: rep.toPNG() });
    } catch { /* skip a missing size */ }
  }
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, `tray-${state}-16.png`)) : img;
}

/**
 * The tray icon exists only while the core does.
 *
 * Stopping the core from Advanced settings used to leave a tray icon behind for
 * a thing that was no longer running. Now the icon is destroyed with the core
 * and recreated when it comes back. The consequence is handled in `close` and
 * `window-all-closed`: with no tray there is nowhere to hide TO, so closing the
 * window has to quit rather than leave an invisible process with no way back.
 */
function ensureTray(wanted) {
  if (wanted && !tray) {
    tray = new Tray(trayImage('off'));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } else if (!wanted && tray) {
    tray.destroy();
    tray = null;
  }
}

function updateTray(s) {
  const want = trayState(s.status) !== 'off';
  ensureTray(want);
  if (!tray) return;
  const state = trayState(s.status);
  const label =
    state === 'active' ? 'Tracey — steadying your pen'
    : state === 'paused' ? 'Tracey — paused'
    : 'Tracey — core not running';

  tray.setImage(trayImage(state));
  tray.setToolTip(label);

  // No status header: the two checkmarks below already say which state we are
  // in, and the tooltip carries the wording on hover.
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Steady my pen',
      type: 'checkbox',
      checked: state === 'active',
      enabled: s.coreInstalled || s.status.present,
      click: () => setEnabled(true),
    },
    {
      // Pause, NOT stop: this leaves the core running so resuming is instant
      // and costs no UAC prompt. Stopping the core outright lives in Advanced
      // settings and in Quit, which are deliberate acts rather than a stray
      // click in a tray menu.
      //
      // A checkbox rather than a plain item, so the pair reads as one state
      // with the tick on whichever half is active. Each click sets an absolute
      // state; the menu is rebuilt from status.cfg straight after, so a click
      // on the already-ticked half simply redraws as it was.
      label: 'Pause Tracey',
      type: 'checkbox',
      checked: state === 'paused',
      enabled: s.coreInstalled || s.status.present,
      click: () => setEnabled(false),
    },
    // Same rule as the card in the window: a live core, not just an installed one.
    { label: 'Calibrate my tremor…', enabled: state !== 'off', click: () => { showWindow(); win.webContents.send('tracey:open-calibration'); } },
    { type: 'separator' },
    // Upper group acts on the pen; lower group opens things and quits.
    { label: 'Open Tracey', click: showWindow },
    { label: 'Open settings folder', click: () => shell.openPath(core.paths().dir) },
    { label: 'Quit Tracey', click: () => { quitting = true; app.quit(); } },
  ]));
}

/* --------------------------------------------------------------- window -- */

/**
 * Screen position of the web content area, in DIP — and NEVER a nonsense one.
 *
 * Windows parks a minimized (and sometimes a hidden) window at about -32000, and
 * `getContentBounds()` reports that faithfully. Publishing it poisoned the
 * calibration pad: a scribble that finished while the window was parked pinned
 * `lastCal.origin` to the parked position, and reopening the wizard drew the whole
 * path ~26000px off the canvas — measured `origin -25600,-25600`, `ink=0`. The
 * scribble looked permanently lost when it was only mis-placed.
 *
 * So: only ever believe a visible, non-minimized window, and remember the last
 * good answer for when it is neither.
 */
let lastOrigin = { x: 0, y: 0 };
function currentOrigin() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
    const b = win.getContentBounds();
    if (Math.abs(b.x) < 20000 && Math.abs(b.y) < 20000) lastOrigin = { x: b.x, y: b.y };
  }
  return lastOrigin;
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Closing only hides the window, so it would otherwise reopen exactly where the
  // user left it - scrolled down, Advanced expanded. Reopening should always land
  // on the main switch. Theme and settings persist; view state does not.
  win.webContents.send('tracey:reset-view');
  core.refreshTablet().then(push);
}

function createWindow() {
  win = new BrowserWindow({
    width: 700,
    // 780, not 880: at 125% display scaling a 1080p desktop is only 864 logical
    // pixels tall, so the old height did not fit on screen at all. 780 leaves
    // 84px of headroom there. It is 60 more than the 720 this used to be, spent
    // on the 36px gap above the Advanced panel (styles.css) plus the 30px the
    // two pad cards occupy whenever they are ENABLED — measure with them
    // disabled and you get a window 30px too short, which is exactly how the
    // summary came to fit only while no tablet was plugged in.
    // Paired with that margin — change one and re-measure with measure.js, or
    // the summary goes back to being cut off. Measured across all seven hero
    // states, pads enabled and disabled: viewport 743 (the frame costs 37),
    // summary bottom 722 in every one of them, 21px clear.
    height: 780,
    // Fixed size. The layout is tuned for exactly this width, dragging the frame
    // only ever stretched whitespace, and a fixed frame is what lets the custom
    // scrollbar own the right edge without the native one reappearing.
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#131C26',   // matches the dark theme: no white flash on open
    title: 'Tracey',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    push();
    // Measured, not assumed: the gap between the outer frame and the content area
    // is exactly the error the calibration pad used to draw with. Recorded once so
    // the number is on the record rather than inferred.
    const o = win.getBounds(), c = win.getContentBounds();
    if (core) core.logUi(`window frame offset: dx=${c.x - o.x} dy=${c.y - o.y} (outer ${o.x},${o.y} content ${c.x},${c.y})`);
  });

  // Renderer errors have twice been invisible here -- the switch that silently did
  // nothing, and a pad that painted empty -- because nothing surfaces a thrown
  // exception in a packaged Electron app with no DevTools open. Send them to the
  // same ui.log as the launch attempts. (Electron 32 signature; level 3 = error.)
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3 && core) core.logUi(`renderer ERROR ${sourceId}:${line} ${message}`);
  });

  // The window is not resizable, but it can be dragged. The calibration pad plots
  // against the content origin, so a stale origin would offset the whole scribble.
  win.on('move', () => {
    if (win && !win.isDestroyed()) win.webContents.send('tracey:window-origin', currentOrigin());
  });

  // Closing the window parks the app in the tray; Quit is explicit.
  win.on('close', (e) => {
    if (!quitting && tray) { e.preventDefault(); win.hide(); }
  });
}

/* ---------------------------------------------------------------- writes -- */

/**
 * The parameters to write on the next config.cfg update.
 *
 * Three sources, and the ORDER depends on whether a core is alive:
 *
 *   core running -> status.cfg first. It is the live truth; the core may have
 *                   been retuned by a Ctrl+Alt+1..5 hotkey that config.cfg
 *                   never saw (apply_preset publishes to status only).
 *   no core      -> config.cfg first. It is what the NEXT core will start from,
 *                   it survives an uninstall, and a status.cfg left behind by a
 *                   core that stopped hours ago is not evidence of anything.
 *
 * config.cfg used to be missing from this list entirely, which meant a REINSTALL
 * reset the user's settings: prefs live in the per-user Electron folder, a fresh
 * install has none, so the startup self-heal wrote 0.4/0.02 straight over a
 * perfectly good config.cfg sitting in %PROGRAMDATA%.
 */
function currentParams() {
  const s = core.readStatus();
  const cfg = core.readConfig();
  const prefs = loadPrefs();
  const live = !!(s.present && s.running);
  const order = live ? [s, cfg, prefs] : [cfg, s, prefs];
  const first = (key, dflt) => {
    for (const src of order) {
      const v = src ? src[key] : null;
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return dflt;
  };
  return {
    fmin: first('fmin', 0.4),
    beta: first('beta', 0.02),
    enabled: live ? (s.enabled ? 1 : 0) : (first('enabled', 0) ? 1 : 0),
  };
}

/**
 * The main switch. Turning ON when no core is running must LAUNCH it — writing
 * enabled=1 to config.cfg does nothing if nobody is reading the file. (This is
 * the whole "I can't turn Tracey on from the UI" case.)
 *
 * Order matters: write the config first (which also clears any stale quit=1),
 * then launch. The core ignores a pre-existing config.cfg at startup and comes
 * up filtering, so it is already in the right state when it appears.
 */
async function setEnabled(on) {
  const p = currentParams();
  const st = core.readStatus();
  const needsLaunch = on && !(st.present && st.running);

  const res = core.writeConfig({ enabled: on ? 1 : 0, fmin: p.fmin, beta: p.beta });
  if (!res.ok) { push(); return res; }
  savePrefs({ enabled: on ? 1 : 0 });

  if (needsLaunch) {
    if (!core.coreInstalled()) {
      push();
      return { ok: false, message:
        `Tracey is not installed yet. Expected it at ${core.paths().exePath}. ` +
        `Run build.ps1 from an elevated PowerShell first.` };
    }
    // Awaited, not fired and forgotten: launchCore only settles once Windows has
    // answered, so a declined UAC prompt arrives here as a real message.
    const launched = await core.launchCore([]);
    if (!launched.ok) { push(); return launched; }
    // Start-Process returns immediately and elevation happens out of our control,
    // so the ONLY proof the core actually started is status.cfg going running=1.
    // Without this check a declined UAC prompt looks exactly like a dead button.
    try {
      await waitFor((s) => s.running, 15000);
    } catch {
      push();
      return { ok: false, message:
        'Tracey did not start. If Windows asked for permission, choose Yes. ' +
        'If no prompt appeared, Smart App Control may be blocking it ' +
        '(Windows Security > App & browser control > Smart App Control > Off).' };
    }
  }

  push();
  return res;
}

function setParams({ fmin, beta, enabled }) {
  const p = currentParams();
  const next = {
    enabled: enabled === undefined ? p.enabled : (enabled ? 1 : 0),
    fmin: fmin === undefined ? p.fmin : fmin,
    beta: beta === undefined ? p.beta : beta,
  };
  const res = core.writeConfig(next);
  savePrefs(next);
  push();
  return res;
}

/**
 * Permanently discard the saved calibration and fall back to Balanced.
 *
 * Deletes the two files that ARE the calibration: `profile.cfg` (the calibrated
 * pair — its absence is what greys out the Custom card) and `calpath.cfg` (the
 * recorded scribble). `status.cfg` is deliberately left alone: a running core
 * rewrites it every second, and deleting it would make the UI read the core as
 * dead for a beat. The stored wizard scribble in pad-state.json goes too, but the
 * practice strokes stay — those are not calibration.
 *
 * CAVEAT, and it is real: a RUNNING core has already loaded profile.cfg into
 * `g_notch_seed_hz` and keeps republishing that tremor_hz on its heartbeat. The
 * UI is immune because it reads the profile, not status. The core is not: its
 * `--notch` seed survives until the core restarts. Clearing does not lie about
 * this — it just cannot reach into the elevated process to fix it.
 */
function clearCalibration() {
  const dir = core.paths().dir;
  const gone = [], failed = [];
  for (const f of ['profile.cfg', 'calpath.cfg']) {
    try { fs.unlinkSync(path.join(dir, f)); gone.push(f); }
    catch (e) { if (e.code !== 'ENOENT') failed.push(`${f} (${e.code})`); }
  }

  const balanced = PRESETS.find((p) => p.name === 'Balanced');
  setParams({ fmin: balanced.fmin, beta: balanced.beta });   // also saves prefs + pushes

  const pad = loadPadState();
  if (pad.lastCal) { pad.lastCal = null; savePadState(pad); }

  core.logUi(`clear calibration: deleted [${gone.join(', ') || 'nothing'}]` +
             (failed.length ? ` FAILED [${failed.join(', ')}]` : ''));
  push();
  return failed.length
    ? { ok: false, message: `Could not delete ${failed.join(', ')}. Close anything using the settings folder and try again.` }
    : { ok: true, message: null };
}

/* ----------------------------------------------------------- calibration -- */
/**
 * IN-PROCESS calibration. The running core measures without stopping:
 *
 *   ensure a core is up -> config calibrate=1 -> wait calibrating=1 ->
 *   rewrite config WITHOUT calibrate -> wait calibrating=0 -> read cal_hz
 *
 * This replaced the old stop/relaunch sequence (quit=1 -> wait running=0 ->
 * launch --calibrate -> wait 1->0 -> relaunch filter). That sequence launched
 * the uiAccess exe TWICE, and every launch of a uiAccess exe goes through
 * AppInfo and costs the user a UAC prompt - so measuring your tremor charged
 * two prompts. Calibrating inside the live core costs none, and it removes the
 * single-instance mutex race between the calibrate run exiting and the filter
 * relaunching.
 *
 * Clearing calibrate=1 while the core is still measuring is deliberate and
 * safe: the core consumed the key when it set calibrating=1, and it ignores
 * config writes for the rest of the measurement. Leaving the key in the file
 * would re-trigger calibration on the next unrelated slider write.
 */

/** Poll status.cfg until `test` passes. Rejects with 'timeout'. */
function waitFor(test, timeoutMs, onTick) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = core.readStatus();
      const elapsed = Date.now() - t0;
      if (test(s, elapsed)) { clearInterval(iv); resolve(s); }
      else if (elapsed > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
      else if (onTick) onTick(s, elapsed);
    }, 200);
  });
}

async function startCalibration() {
  if (calibration) return { ok: false, message: 'Calibration is already running.' };
  if (!core.coreInstalled()) {
    return { ok: false, message: `Tracey could not be found at ${core.paths().exePath}.` };
  }

  const emit = (p) => { if (win && !win.isDestroyed()) win.webContents.send('tracey:calibration', p); };
  const snapshot = currentParams();          // taken before we disturb anything
  calibration = { phase: 'starting' };
  push();

  try {
    // 1. there must be a live core to measure in. Starting one costs the only
    //    UAC prompt in this whole flow, and only when Tracey was not already on.
    if (!core.readStatus().running) {
      emit({ phase: 'starting' });
      core.writeConfig({ enabled: 1, fmin: snapshot.fmin, beta: snapshot.beta });
      const launched = await core.launchCore([]);
      if (!launched.ok) throw new Error(launched.message);
      try { await waitFor((s) => s.running, 15000); }
      catch { throw new Error('Tracey did not start, so there was nothing to calibrate. If Windows asked for permission, choose Yes.'); }
    }

    // 2. ask the live core to measure
    core.writeConfig({ enabled: 1, fmin: snapshot.fmin, beta: snapshot.beta, calibrate: 1 });
    try {
      await waitFor((s) => s.calibrating, 6000);
    } catch {
      throw new Error('Tracey did not begin calibrating. It may be running an older build — reinstall the core with build.ps1.');
    }

    // 3. clear the one-shot key immediately, or the next slider write re-triggers it
    core.writeConfig({ enabled: 1, fmin: snapshot.fmin, beta: snapshot.beta });

    // 4. scribble window. CAL_SECONDS in the core is the authority; the renderer
    //    animates against the same figure.
    calibration.phase = 'recording';
    // The scribble gets its OWN fast poll. Riding waitFor's 200 ms status tick
    // put the drawn line a visible step behind the hand; the core republishes
    // the path ~25x/sec, so read it at a comparable rate. The whole path is
    // sent each time, so the renderer just replaces what it has.
    const t0 = Date.now();
    const paint = setInterval(() => {
      const cp = core.readCalPath();
      emit({ phase: 'recording', elapsed: Date.now() - t0,
             samples: core.readStatus().cal_samples, path: cp.points, bounds: cp.bounds });
    }, 60);
    try {
      await waitFor((s) => !s.calibrating, 40000);
    } finally {
      clearInterval(paint);
    }

    // 5. cal_hz is latched by the core: the measured Hz, or 0 if it failed.
    const result = core.readStatus();
    const hz = result.cal_hz !== null ? result.cal_hz : result.tremor_hz;

    // 6. hand the pause state back the way we found it. The core restores it
    //    itself, but say so explicitly so config.cfg and reality agree.
    core.writeConfig({ enabled: snapshot.enabled, fmin: result.fmin ?? snapshot.fmin, beta: result.beta ?? snapshot.beta });

    calibration = null;
    emit({ phase: 'done', tremor_hz: hz, preset: result.preset });
    push();
    return { ok: true };

  } catch (err) {
    calibration = null;
    // Never leave calibrate=1 behind: it is one-shot, and a stale one would fire
    // calibration again the next time any slider is touched.
    try { core.writeConfig({ enabled: snapshot.enabled, fmin: snapshot.fmin, beta: snapshot.beta }); } catch { /* best effort */ }
    const message = err.message === 'timeout'
      ? 'Tracey stopped responding during calibration. Try again, or restart it from the Advanced panel.'
      : err.message;
    emit({ phase: 'error', message });
    push();
    return { ok: false, message };
  }
}

/** quit=1 is a real stop, unlike enabled=0 which only pauses. */
function stopCore() {
  const p = currentParams();
  const res = core.writeConfig({ ...p, quit: 1 });
  push();
  return res;
}

/** Always clear a stale quit=1 before launching, or the core exits on sight. */
async function startCore() {
  const p = currentParams();
  core.writeConfig({ enabled: p.enabled, fmin: p.fmin, beta: p.beta });
  const res = await core.launchCore([]);
  if (res.ok) {
    // Same reason as setEnabled: Start-Process returning is not proof the core
    // came up, so wait for status.cfg to say so before claiming success.
    try { await waitFor((s) => s.running, 15000); }
    catch {
      push();
      return { ok: false, message: 'Tracey did not start. If Windows asked for permission, choose Yes.' };
    }
  }
  push();
  return res;
}

/* ------------------------------------------------------------- shutdown -- */
/**
 * Quitting Tracey stops the core too.
 *
 * They are separate processes, and the core is elevated, so closing this window
 * left the filter running with no visible owner - the pen stayed filtered and
 * the only ways back were Ctrl+Alt+Q or Task Manager. quit=1 is the one clean
 * stop a non-elevated UI has.
 *
 * The key is one-shot, so it MUST be cleared afterwards: left in config.cfg it
 * would kill the next core the instant it starts, including one launched by
 * hand. That is why this waits for the core to actually go before rewriting.
 */
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const st = core.readStatus();
    if (st.present && st.running) {
      const p = currentParams();
      core.writeConfig({ ...p, quit: 1 });
      try { await waitFor((s) => !s.running, 5000); }
      catch { /* it may already be gone, or wedged; either way stop waiting */ }
      core.writeConfig({ enabled: p.enabled, fmin: p.fmin, beta: p.beta });
    }
  } catch { /* a cleanup failure must never trap the user in a window that won't close */ }
  if (core) core.unwatch();
  app.exit(0);
}

/* ------------------------------------------------------------------ ipc -- */

function wireIpc() {
  ipcMain.handle('tracey:get-state', () => uiState());
  ipcMain.handle('tracey:set-enabled', (_e, on) => setEnabled(on));
  ipcMain.handle('tracey:set-params', (_e, p) => setParams(p));
  ipcMain.handle('tracey:calibrate', () => startCalibration());
  ipcMain.handle('tracey:open-folder', () => shell.openPath(core.paths().dir));
  ipcMain.handle('tracey:start-core', () => startCore());
  ipcMain.handle('tracey:stop-core', () => stopCore());
  ipcMain.handle('tracey:clear-calibration', () => clearCalibration());
  ipcMain.handle('tracey:get-pad-state', () => {
    const s = loadPadState();
    if (core) core.logUi(`pad-state read: strokes=${(s.strokes || []).length} lastCal=${s.lastCal ? (s.lastCal.path || []).length + 'pts' : 'null'}`);
    return s;
  });
  ipcMain.handle('tracey:set-pad-state', (_e, s) => {
    if (core) core.logUi(`pad-state write: strokes=${(s.strokes || []).length} lastCal=${s.lastCal ? (s.lastCal.path || []).length + 'pts' : 'null'}`);
    return savePadState(s);
  });

  /**
   * Screen position of the WEB CONTENT area, in DIP.
   *
   * The calibration pad maps the core's screen coordinates into the canvas, so it
   * needs the canvas's absolute origin. The renderer cannot compute that on its
   * own: Chromium's `window.screenX/screenY` report the OUTER window, so on a
   * framed window they sit a title bar above the viewport and every plotted point
   * lands that far down the pad. `getContentBounds()` is the viewport rectangle by
   * definition, which removes the guesswork rather than correcting for it.
   */
  ipcMain.handle('tracey:content-origin', () => currentOrigin());

  // "Choose folder" / "Use default" were removed from the UI: the folder is
  // fixed by the core (%PROGRAMDATA%\Tracey) and pointing the UI somewhere else
  // just silently disconnected it from the running core. TRACEY_DIR still
  // overrides it for development and is what the test suite uses.
}

/* ------------------------------------------------------------------ app -- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    const prefs = loadPrefs();
    core = new CoreComms(prefs.dir || defaultDir());
    core.onStatus(() => push());
    core.watch();

    /* Clear a STALE `quit=1` before anything else.
     *
     * Quitting writes quit=1, waits for running=0, then removes the key. A UI that
     * dies inside that window - force-killed, crashed, machine shut down - leaves a
     * one-shot STOP sitting in the file, and the next core to launch reads it and
     * exits immediately. The symptom is brutal to diagnose: UAC prompts, the core
     * starts, and the switch flips straight back to off with no error anywhere.
     * We are starting up, so nothing we own wants the core dead. Observed on this
     * machine 2026-07-28. */
    try {
      const st = core.readStatus();
      if (!st.running) {
        const p = currentParams();
        core.writeConfig({ enabled: p.enabled, fmin: p.fmin, beta: p.beta });  // omits quit
      }
    } catch { /* a stuck key is bad; failing to start over it would be worse */ }
    // Fallback probe, for when no core is running to answer. It costs ~3.3 s of
    // PowerShell, so it is paced slowly AND skipped entirely whenever the core is
    // up and already reporting `pen` a thousand times more cheaply.
    core.refreshTablet().then(push);
    setInterval(() => {
      const s = core.readStatus();
      if (s.running && s.pen !== null) return;
      core.refreshTablet().then(push);
    }, 20000);

    wireIpc();
    createWindow();

    // No tray until the core is actually running; updateTray() creates and
    // destroys it to follow the core.
    updateTray(uiState());
  });

  app.on('before-quit', (e) => {
    quitting = true;
    if (shuttingDown) return;      // second pass, from our own app.exit()
    e.preventDefault();            // hold the quit open until the core is down
    shutdown();
  });
  // Only park in the tray if there IS a tray. With the core stopped there is
  // none, and staying alive would leave a process with no window and no icon —
  // unreachable and unkillable except through Task Manager.
  app.on('window-all-closed', () => { if (!tray) shutdown(); });
  app.on('activate', showWindow);
}
