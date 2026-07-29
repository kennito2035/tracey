#!/usr/bin/env node
'use strict';
/**
 * Contract regression suite. Runs the UI's side of the control channel against
 * the mock core and checks every guarantee in the core/UI control contract.
 *
 *   npm run verify
 *
 * Uses a scratch folder, never the real one. Safe to run on the demo machine.
 */

const os = require('os');
const path = require('path');
const SCRATCH = path.join(os.tmpdir(), 'tracey-verify');
process.env.TRACEY_DIR = SCRATCH;
// The real core measures for CAL_SECONDS (10). What is under test is the
// SEQUENCE, not the duration, so the mock's window is shortened here.
process.env.TRACEY_MOCK_CAL_MS = '1500';
const {CoreComms}=require(path.join(__dirname,'..','electron','core-comms'));
const {spawn}=require('child_process');
const fs=require('fs');
const MOCK=path.join(__dirname,'mock-core.js');
require('fs').rmSync(SCRATCH,{recursive:true,force:true});
require('fs').mkdirSync(SCRATCH,{recursive:true});
const core=new CoreComms(SCRATCH);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function waitFor(t,to){return new Promise((res,rej)=>{const t0=Date.now();
 const iv=setInterval(()=>{const s=core.readStatus();
  if(t(s)){clearInterval(iv);res(s);}else if(Date.now()-t0>to){clearInterval(iv);rej(new Error('timeout'));}},200);});}
const launch=a=>{const c=spawn(process.execPath,[MOCK,...a],{stdio:'ignore',detached:true,env:process.env});c.unref();return c;};
let pass=0,fail=0;
const t=(n,c)=>{ if(c){pass++;console.log('  PASS',n);} else {fail++;console.log('  FAIL',n);} };
(async()=>{
 console.log('--- cold state ---');
 t('status missing before core', core.readStatus().present===false);
 t('writable', core.checkWritable().ok);

 console.log('--- start + enable ---');
 core.writeConfig({enabled:0,fmin:0.4,beta:0.02}); launch([]);
 await waitFor(s=>s.running,6000);
 t('core running', core.readStatus().running===1);
 t('paused state', core.readStatus().enabled===0);
 core.writeConfig({enabled:1,fmin:0.4,beta:0.02});
 await waitFor(s=>s.enabled===1,3000);
 t('enable applied live', core.readStatus().enabled===1);

 console.log('--- clamping ---');
 core.writeConfig({enabled:1,fmin:99,beta:0});
 await sleep(600);
 const c=core.readStatus();
 t('fmin clamped to 1.0', Math.abs(c.fmin-1.0)<1e-6);
 t('beta clamped to 0.007', Math.abs(c.beta-0.007)<1e-9);
 t('config is pure ASCII', [...fs.readFileSync(path.join(SCRATCH,'config.cfg'))].every(b=>b<128));
 t('no quit key in normal write', !fs.readFileSync(path.join(SCRATCH,'config.cfg'),'utf8').includes('quit'));

 console.log('--- calibration sequence ---');
 const snap={enabled:1,fmin:0.4,beta:0.02};
 core.writeConfig({...snap,quit:1});
 await waitFor(s=>!s.running,8000); t('quit=1 stops core', core.readStatus().running===0);
 core.writeConfig(snap); await sleep(300);
 t('quit cleared', !fs.readFileSync(path.join(SCRATCH,'config.cfg'),'utf8').includes('quit'));
 launch(['--calibrate']);
 await waitFor(s=>s.running,5000); t('calibrate started', true);
 await waitFor(s=>!s.running,30000);
 const hz=core.readStatus().tremor_hz;
 t('tremor_hz read', typeof hz==='number' && hz>5 && hz<12);
 core.writeConfig(snap); await sleep(200); launch([]);
 await waitFor(s=>s.running,8000);
 t('filter relaunched', core.readStatus().running===1);
 t('enabled restored', core.readStatus().enabled===1);

 console.log('--- in-process calibration (the UI path: no relaunch, no UAC) ---');
 // A filter core is up from the block above. The UI now measures INSIDE it.
 // The old sequence stopped the core and launched --calibrate, then relaunched
 // the filter - two launches of a uiAccess exe, so two UAC prompts, just to
 // measure a tremor. In-process costs none.
 {
  const snap = { enabled: 1, fmin: 0.4, beta: 0.02 };
  const hzBefore = core.readStatus().cal_hz;
  core.writeConfig({ ...snap, calibrate: 1 });
  await waitFor(s => s.calibrating === 1, 5000);
  t('calibrate=1 starts calibration', core.readStatus().calibrating === 1);
  t('core stays RUNNING while calibrating', core.readStatus().running === 1);

  core.writeConfig(snap);                       // clear the one-shot mid-measurement
  t('calibrate key cleared', !fs.readFileSync(path.join(SCRATCH,'config.cfg'),'utf8').includes('calibrate'));

  await waitFor(s => !s.calibrating, 20000);
  const done = core.readStatus();
  t('core still running afterwards (no relaunch needed)', done.running === 1);
  t('cal_hz latched as the result', typeof done.cal_hz === 'number' && done.cal_hz > 5 && done.cal_hz < 12);
  t('cal_hz actually changed', done.cal_hz !== hzBefore);
  // The wizard shows nothing on screen while the core measures, so this counter
  // is its only evidence the pen is being seen at all.
  t('cal_samples reported', typeof done.cal_samples === 'number' && done.cal_samples > 0);

  // THE reason calibrate must be one-shot: an ordinary slider write afterwards
  // must not start another 10-second measurement under the user's hands.
  core.writeConfig({ ...snap, fmin: 0.5 });
  await sleep(800);
  t('an ordinary write does not re-trigger calibration', core.readStatus().calibrating === 0);
  core.writeConfig(snap); await sleep(400);
 }

 console.log('--- profile / the Custom card ---');
 // The UI reads this on EVERY state push to decide whether "Custom" is
 // selectable. A momentary bad read flipped the card disabled for one frame,
 // which is visible as a flicker, so a torn or unreadable file must return the
 // LAST GOOD answer -- only a deleted file means "no calibration".
 {
  const iso = path.join(SCRATCH, 'prof');
  fs.mkdirSync(iso, { recursive: true });
  const pc = new CoreComms(iso);
  const f = path.join(iso, 'profile.cfg');
  t('no profile -> null', pc.readProfile() === null);
  fs.writeFileSync(f, 'fmin=0.1500\nbeta=0.08000\npreset=4\ntremor_hz=7.48\n');
  const good = pc.readProfile();
  t('profile parsed', good && Math.abs(good.fmin - 0.15) < 1e-9 && Math.abs(good.beta - 0.08) < 1e-9);
  t('tremor_hz carried', good.tremor_hz === 7.48);
  // Half-written, exactly what a truncate-and-rewrite exposes.
  await sleep(20);
  fs.writeFileSync(f, '');
  t('torn file keeps the last good profile', pc.readProfile() !== null);
  // Deleted is definitive.
  fs.rmSync(f, { force: true });
  t('deleted profile -> null', pc.readProfile() === null);
 }

 console.log('--- calibration path ---');
 // The wizard draws this. It comes from the CORE, not from the system cursor:
 // the cursor moves for any pointing device, so sampling it drew the TOUCHPAD.
 {
  const cp = path.join(SCRATCH, 'calpath.cfg');
  fs.writeFileSync(cp, 'bounds=0 0 1920 1080\n0 0\n960 540\n1920 1080\n');
  const r = core.readCalPath();
  t('calpath parsed', r.points.length === 3);
  // PHYSICAL screen pixels, deliberately NOT normalised: the wizard draws the
  // stroke 1:1 under the pen, so it needs real screen coordinates.
  t('calpath points stay in screen pixels', r.points[1][0] === 960 && r.points[1][1] === 540);
  t('calpath reports desktop bounds', r.bounds.w === 1920 && r.bounds.h === 1080);
  // Multi-monitor: a desktop starting at a negative origin must survive intact.
  fs.writeFileSync(cp, 'bounds=-1920 0 3840 1080\n-1920 0\n1920 1080\n');
  const off = core.readCalPath();
  t('calpath keeps a negative desktop origin',
    off.bounds.x === -1920 && off.points[0][0] === -1920);
  // A truncated/garbage file must yield nothing, never NaN coordinates.
  fs.writeFileSync(cp, 'bounds=0 0 0 0\nrubbish\n');
  t('calpath rejects a bad header', core.readCalPath().points.length === 0);
  fs.rmSync(cp, { force: true });
  t('missing calpath is not an error', core.readCalPath().points.length === 0);
 }

 console.log('--- pen presence ---');
 // The core probes the tablet natively (~0.65 ms) and republishes every second,
 // so the UI can react in ~1 s instead of the ~24 s its own PowerShell probe cost.
 {
  t('pen read from a live core', core.readStatus().pen === 1);

  // The pen=-1/0 cases are checked in a SEPARATE folder with no core in it.
  // Hand-editing the live status.cfg raced the running mock, which owns that
  // file and rewrites it 5x/sec — it swallowed the following quit=1 and made
  // the whole suite fail two runs out of three. Tests must not fight the core.
  const iso = path.join(SCRATCH, 'iso');
  fs.mkdirSync(iso, { recursive: true });
  const isoCore = new CoreComms(iso);
  const base = 'running=1\nenabled=1\nfmin=0.400\nbeta=0.0200\npreset=2\n' +
               'tremor_hz=0.00\ncalibrating=0\ncal_hz=0.00\ncal_samples=0\nheartbeat=1\n';
  // "Could not tell" must never be reported as "no tablet": the UI shows a real
  // "no pen tablet" warning off this, and a false one sends people hunting cables.
  fs.writeFileSync(path.join(iso, 'status.cfg'), base + 'pen=-1\n');
  t('pen=-1 is UNKNOWN, not absent', isoCore.readStatus().pen === null);
  fs.writeFileSync(path.join(iso, 'status.cfg'), base + 'pen=0\n');
  t('pen=0 is absent', isoCore.readStatus().pen === 0);
  fs.writeFileSync(path.join(iso, 'status.cfg'), base);
  t('absent pen key is UNKNOWN', isoCore.readStatus().pen === null);
 }

 console.log('--- liveness / heartbeat ---');
 // Start from a clean slate: the mock's mutex refuses to launch while a core is up.
 core.writeConfig({...snap,quit:1});
 await waitFor(s=>!s.running,8000);
 core.writeConfig(snap); await sleep(300);
 const child=launch([]);
 await waitFor(s=>s.running,8000);
 const hb1=Number(core.readStatus().raw.heartbeat);
 await sleep(1200);
 const hb2=Number(core.readStatus().raw.heartbeat);
 t('heartbeat present', Number.isFinite(hb1));
 t('heartbeat advances while alive', hb2>hb1);
 t('tremor_hz always written (0 = uncalibrated)', typeof core.readStatus().tremor_hz==='number');

 // Hard-kill, like ending the task in Task Manager: the core never gets to
 // write running=0, so status.cfg is left claiming the pen is being filtered.
 try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
 await sleep(3500);
 const stale=core.readStatus();
 const ageMs=Date.now()-fs.statSync(path.join(SCRATCH,'status.cfg')).mtimeMs;
 t('killed core leaves running=1 in the file', Number(stale.raw.running)===1);
 t('heartbeat stops advancing after kill', Number(stale.raw.heartbeat)===hb2);
 t('status.cfg goes stale (>3s)', ageMs>3000);
 // THE requirement this suite exists to enforce.
 t('UI reports a killed core as NOT running', stale.running===0 && stale.stale===true);
 fs.rmSync(path.join(SCRATCH,'status.cfg'),{force:true});   // reset the mock's file-based mutex
 await sleep(200);

 console.log('--- launch path ---');
 // Everything above spawns the mock directly, so launchCore() itself was never
 // covered - which is exactly how a broken launcher shipped. `detached: true`
 // maps to DETACHED_PROCESS on Windows, powershell.exe then has no console and
 // exits 0 WITHOUT running -Command, so Start-Process never happened and the
 // core never started, silently. This proves the launcher runs its target.
 {
  const marker = path.join(SCRATCH, 'launched.txt');
  const isWin = process.platform === 'win32';
  const stub = path.join(SCRATCH, isWin ? 'stub-core.cmd' : 'stub-core.sh');
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(stub, isWin
   ? `@echo off\r\n> "${marker}" echo launched\r\n`
   : `#!/bin/sh\necho launched > "${marker}"\n`);
  if (!isWin) fs.chmodSync(stub, 0o755);
  const realExe = core.exePath;
  core.exePath = stub;
  const r = await core.launchCore([]);
  t('launchCore reports ok', r.ok === true);
  let ran = false;
  for (let i = 0; i < 50 && !ran; i++) { await sleep(100); ran = fs.existsSync(marker); }
  t('launchCore actually ran the target', ran);
  core.exePath = realExe;
 }

 console.log('--- teardown ---');
 core.writeConfig(snap); await sleep(200); launch([]);
 await waitFor(s=>s.running,8000);
 core.writeConfig({...snap,quit:1});
 await waitFor(s=>!s.running,8000); t('final stop', core.readStatus().running===0);

 console.log(`\n${pass} passed, ${fail} failed`);
 process.exit(fail?1:0);
})().catch(e=>{console.error('ERROR',e.message);process.exit(1);});
