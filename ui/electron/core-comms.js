'use strict';
/**
 * core-comms.js — the ONLY place that knows how to talk to the tracey core.
 *
 * The core is a separate signed process, not a library. All control happens
 * through two small key=value text files in a per-OS folder:
 *
 *   config.cfg   UI writes  -> enabled, fmin, beta, quit
 *   status.cfg   UI reads   <- running, enabled, fmin, beta, preset, tremor_hz
 *
 * Swapping in a real core on macOS/Linux later means editing `defaultDir()`
 * and `launchCore()` here and nothing else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PARAM_RANGES = {
  fmin: { min: 0.15, max: 1.0, step: 0.01 },
  beta: { min: 0.007, max: 0.08, step: 0.001 },
};

/**
 * Liveness. The core rewrites status.cfg once a second and bumps `heartbeat`.
 * A core that is KILLED or crashes never gets to write running=0, so the file
 * would sit there claiming running=1 forever — and this app would keep telling
 * someone their pen is being steadied when it is not. So a status.cfg older than
 * STALE_MS with no fresh heartbeat means the core is gone.
 *
 * Three missed beats, so a momentarily busy machine doesn't flap.
 */
const STALE_MS = 3000;

/**
 * How long to wait for Start-Process to return. With an elevated target it does
 * not return until the UAC prompt is answered, so this is really "how long the
 * user gets to find the prompt", not a machine timeout.
 */
const LAUNCH_TIMEOUT_MS = 90000;

// Preset id 0 is reserved by the core for "custom" (raw slider values).
const PRESETS = [
  { id: 1, name: 'Gentle', fmin: 0.7, beta: 0.05, hint: 'A light touch. Your pen still feels immediate.' },
  { id: 2, name: 'Balanced', fmin: 0.4, beta: 0.02, hint: 'A good place to start.' },
  { id: 3, name: 'Steadiest', fmin: 0.22, beta: 0.01, hint: 'For a stronger tremor. A little more lag.' },
];

function defaultDir() {
  if (process.env.TRACEY_DIR) return process.env.TRACEY_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Tracey');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Tracey');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'tracey');
}

/*
 * The core has TWO filenames, and that is deliberate.
 *
 * The installer puts the UI and the core in ONE directory, and the UI's exe is
 * `Tracey.exe` - so the core cannot also be `tracey.exe` there, because Windows
 * filenames are case-insensitive and one would overwrite the other. The core is
 * therefore installed as `tracey-core.exe`, while `build.ps1` still produces
 * `tracey.exe` for the development install. Both are the same binary; only the
 * name differs, which Authenticode does not care about.
 *
 * Resolution order matters. The FIRST candidate is "beside the running UI",
 * which is what actually keeps this honest: an earlier build set
 * `win.executableName`, and because electron-builder derives the INSTALL
 * DIRECTORY from that same value (appInfo.js: productFilename), the whole app
 * silently moved to C:\Program Files\TraceyUI while this function still pointed
 * at C:\Program Files\Tracey. On the dev machine a leftover core happened to sit
 * at the old path and everything looked fine; on a clean machine the UI would
 * have found no core, disabled the switch, and done nothing. Looking beside the
 * UI first means the two cannot drift apart again, whatever the directory ends
 * up being called.
 */
const CORE_INSTALLED = 'tracey-core.exe';   // shipped by the installer
const CORE_DEV       = 'tracey.exe';        // produced by build.ps1

function defaultExe() {
  if (process.env.TRACEY_EXE) return process.env.TRACEY_EXE;
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const candidates = [];
    try {
      // Only when packaged: in development app.getPath('exe') is electron.exe,
      // sitting in node_modules, and no core will ever be beside it.
      const { app } = require('electron');
      if (app && app.isPackaged) {
        candidates.push(path.join(path.dirname(app.getPath('exe')), CORE_INSTALLED));
      }
    } catch { /* not running under Electron at all, e.g. tools/verify.js */ }
    candidates.push(path.join(pf, 'Tracey', CORE_INSTALLED));
    candidates.push(path.join(pf, 'Tracey', CORE_DEV));
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch { /* unreadable: try the next */ }
    }
    // None present. Report the INSTALLED path, since that is the one a user who
    // ran the installer would expect to see named in the "core not found" error.
    return path.join(pf, 'Tracey', CORE_INSTALLED);
  }
  if (process.platform === 'darwin') return '/usr/local/bin/tracey_mac';
  return '/usr/local/bin/tracey_linux';
}

function parseCfg(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

function num(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Replace `dest` with `tmp`, retrying briefly on a Windows sharing violation.
 *
 * The core reads config.cfg ~5x/sec using MSVC `fopen`, which does NOT grant
 * FILE_SHARE_DELETE. A rename landing inside that read window fails with
 * EBUSY/EPERM. It is rare per write (~0.05%), but a slider drag issues hundreds,
 * and a silently dropped write leaves the pen on the old smoothing — the user
 * moves the slider and nothing happens.
 *
 * Worst case here is 3 retries * 4 ms = 12 ms, which is imperceptible on a drag.
 */
const RENAME_RETRIES = 4;
const RENAME_BACKOFF_MS = 4;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return attempt;
    } catch (err) {
      const transient = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!transient || attempt >= RENAME_RETRIES) throw err;
      sleepSync(RENAME_BACKOFF_MS);
    }
  }
}

class CoreComms {
  constructor(dir) {
    this.setDir(dir || defaultDir());
    this.exePath = defaultExe();
    this._watcher = null;
    this._poll = null;
    this._last = null;
    this._listeners = new Set();
    this._profile = null;      // cached profile.cfg; see readProfile()
    this._profileAt = -1;      // its mtime, so it is re-read only when it changes
    this.tablet = { checked: false, pen: null, ready: null, flags: null };
  }

  setDir(dir) {
    this.dir = dir;
    this._profile = null; this._profileAt = -1;   // cache belongs to the old folder
    this.configPath = path.join(dir, 'config.cfg');
    this.statusPath = path.join(dir, 'status.cfg');
    if (this._watcher || this._poll) this.watch(); // rebind to the new folder
  }

  paths() {
    return { dir: this.dir, configPath: this.configPath, statusPath: this.statusPath, exePath: this.exePath };
  }

  /** Read status.cfg. Never throws — a missing file is a normal state. */
  readStatus() {
    let raw, ageMs = null;
    try {
      raw = fs.readFileSync(this.statusPath, 'utf8');
      ageMs = Date.now() - fs.statSync(this.statusPath).mtimeMs;
    } catch (err) {
      return {
        present: false,
        reason: err.code === 'ENOENT' ? 'missing' : err.code,
        running: 0, enabled: 0, fmin: null, beta: null, preset: null, tremor_hz: null,
        calibrating: 0, cal_hz: null, cal_samples: null, pen: null,
        stale: false, ageMs: null,
      };
    }
    const c = parseCfg(raw);
    const claimsRunning = num(c.running, 0) ? 1 : 0;

    // Only judge staleness when the core actually heartbeats. An older core build
    // rewrote status.cfg only on change, so ageMs would grow while it sat there
    // filtering perfectly well — never report that one as dead.
    const heartbeats = c.heartbeat !== undefined;
    const stale = heartbeats && claimsRunning === 1 && ageMs !== null && ageMs > STALE_MS;

    return {
      present: true,
      reason: null,
      running: stale ? 0 : claimsRunning,   // a dead core is not running, whatever the file says
      enabled: num(c.enabled, 0) ? 1 : 0,
      fmin: num(c.fmin, null),
      beta: num(c.beta, null),
      preset: num(c.preset, null),
      tremor_hz: num(c.tremor_hz, null),
      // In-process calibration. `calibrating` is live state; `cal_hz` is the
      // LATCHED result of the last attempt (0 = it failed), which is why the
      // result is not read back out of tremor_hz - the 1 Hz heartbeat keeps
      // rewriting that and would race the read.
      calibrating: num(c.calibrating, 0) ? 1 : 0,
      cal_hz: num(c.cal_hz, null),
      cal_samples: num(c.cal_samples, null),
      // Pen-tablet presence, probed natively by the core (0.65 ms) on its 1 Hz
      // heartbeat. -1 or absent = the core could not tell, which is NOT "absent".
      pen: (num(c.pen, -1) === 0 || num(c.pen, -1) === 1) ? num(c.pen, -1) : null,
      stale,                                 // true = the file claims running but the core is gone
      ageMs,
      raw: c,
    };
  }

  /**
   * Write config.cfg atomically (temp file + rename) so the core, which polls
   * a few times a second, can never read a half-written file.
   *
   * `quit` and `calibrate` are written ONLY when truthy. The core treats quit=1
   * as "stop the process" and calibrate=1 as "measure my tremor now, in-process";
   * enabled=0 is merely "pause". Both are ONE-SHOT: a stale key left in the file
   * would make the next core exit on sight, or re-run calibration on the next
   * unrelated write, so every ordinary write omits them, which clears them.
   */
  writeConfig({ enabled, fmin, beta, quit, calibrate }) {
    const e = enabled ? 1 : 0;
    const f = clamp(Number(fmin), PARAM_RANGES.fmin.min, PARAM_RANGES.fmin.max);
    const b = clamp(Number(beta), PARAM_RANGES.beta.min, PARAM_RANGES.beta.max);
    let body =
      '# config.cfg - written by the Tracey UI. Safe to overwrite.\n' +
      `enabled=${e}\n` +
      `fmin=${f.toFixed(3)}\n` +
      `beta=${b.toFixed(4)}\n`;
    if (quit) body += 'quit=1\n';
    if (calibrate) body += 'calibrate=1\n';

    const tmp = this.configPath + '.tmp';
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, body, 'utf8');
      const attempts = renameWithRetry(tmp, this.configPath);
      return attempts > 1 ? { ok: true, attempts } : { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* leave no .tmp litter in the folder */ }
      return { ok: false, code: err.code, message: describeWriteError(err, this.dir) };
    }
  }

  /**
   * The saved calibration profile, if there is one.
   *
   * This is what the "Custom" card in "How much help?" applies. It has to come
   * from profile.cfg rather than status.cfg: status carries the values in USE
   * right now, which is not the same thing once the user has touched a slider,
   * and the card needs to offer the calibrated pair specifically.
   */
  readProfile() {
    const p = path.join(this.dir, 'profile.cfg');
    let mtime;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch (err) {
      // ENOENT is the definitive answer: never calibrated, or it was deleted.
      // Anything else (a sharing violation while the core replaces it) is
      // transient and must NOT be reported as "no calibration".
      if (err.code === 'ENOENT') { this._profile = null; this._profileAt = -1; }
      return this._profile ?? null;
    }
    if (mtime === this._profileAt) return this._profile ?? null;   // cached
    try {
      const c = parseCfg(fs.readFileSync(p, 'utf8'));
      const fmin = num(c.fmin, null), beta = num(c.beta, null);
      // A half-written file parses to nothing. Keep the last good answer rather
      // than flipping the Custom card to disabled for one frame.
      if (fmin === null || beta === null) return this._profile ?? null;
      this._profileAt = mtime;
      this._profile = { fmin, beta, tremor_hz: num(c.tremor_hz, null) };
    } catch { /* transient read failure: keep what we had */ }
    return this._profile ?? null;
  }

  /**
   * The calibration scribble, as the CORE saw it.
   *
   * Not sampled from the system cursor: that moves for any pointing device, so
   * with the tablet unplugged it faithfully drew the touchpad. The core is the
   * only thing that knows which samples came from the pen, so it writes them.
   *
   * Returns the points as the core recorded them — PHYSICAL screen pixels —
   * plus the virtual-desktop bounds. Deliberately not normalised: the wizard
   * draws the stroke 1:1 under the pen, exactly like the practice pad, so it
   * needs real screen coordinates rather than a 0..1 box to fit. Never throws;
   * no file yet is normal.
   */
  readCalPath() {
    let raw;
    try { raw = fs.readFileSync(path.join(this.dir, 'calpath.cfg'), 'utf8'); }
    catch { return { points: [], bounds: null }; }
    let bounds = null;
    const points = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('bounds=')) {
        const [x, y, w, h] = line.slice(7).trim().split(/\s+/).map(Number);
        if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) bounds = { x, y, w, h };
        continue;
      }
      if (!line.trim()) continue;
      // A lone "-" is a pen-up. It is kept in the list as null rather than
      // dropped: without it the wizard drew one continuous polyline and joined
      // the end of one stroke to the start of the next with a line the user
      // never made.
      if (line.trim() === '-') { points.push(null); continue; }
      const [px, py] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(px) && Number.isFinite(py)) points.push([px, py]);
    }
    if (!bounds) return { points: [], bounds: null };   // header missing or junk
    return { points, bounds };
  }

  /** True if this process can actually create files in the folder. */
  checkWritable() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const probe = path.join(this.dir, '.tracey-write-probe');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code, message: describeWriteError(err, this.dir) };
    }
  }

  /**
   * The UI's OWN settings file, read back.
   *
   * config.cfg is UI-owned and the core only reads it, so it was never read back
   * here — the UI assumed it already knew what it had written. That assumption
   * breaks the moment the UI is REINSTALLED: its prefs live in the per-user
   * Electron data folder, a fresh install starts with none, and the startup
   * self-heal then rewrote config.cfg from defaults, silently resetting settings
   * that were sitting right there on disk. config.cfg outlives the UI (the
   * uninstaller leaves %PROGRAMDATA% alone on purpose) and is what the NEXT core
   * starts from, so it is the authority whenever no core is running.
   *
   * Missing or unparseable reads as "nothing known" - never as zeros, which
   * would clamp the filter to nonsense.
   */
  readConfig() {
    const num = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    try {
      const c = parseCfg(fs.readFileSync(this.configPath, 'utf8'));
      return { enabled: num(c.enabled), fmin: num(c.fmin), beta: num(c.beta) };
    } catch {
      return { enabled: null, fmin: null, beta: null };
    }
  }

  /** Emit on any status change; fs.watch is flaky across filesystems, so poll too. */
  watch(intervalMs = 400) {
    this.unwatch();
    const tick = () => {
      const s = this.readStatus();
      // EVERY field the UI renders must be in this signature, or a change in it
      // fires no listener and the window silently keeps showing the old value.
      // `pen` was missing: the core correctly logged "pen tablet disconnected"
      // and wrote pen=0, but nothing re-rendered until something ELSE in the
      // signature moved — which is why unplugging looked like it did nothing
      // until the core was stopped and `running` changed.
      //
      // Deliberately excluded: heartbeat and ageMs (change on every read), and
      // cal_samples (changes ~50x/sec while calibrating). Including any of them
      // would rebuild the tray menu several times a second forever.
      const sig = JSON.stringify([s.present, s.running, s.enabled, s.fmin, s.beta,
                                  s.preset, s.tremor_hz, s.stale,
                                  s.pen, s.calibrating, s.cal_hz]);
      if (sig !== this._last) {
        this._last = sig;
        for (const fn of this._listeners) fn(s);
      }
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this._watcher = fs.watch(this.dir, (_e, name) => {
        if (!name || name.toLowerCase().startsWith('status')) tick();
      });
    } catch { /* poll alone is enough */ }
    this._poll = setInterval(tick, intervalMs);
    tick();
  }

  unwatch() {
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this._last = null;
  }

  onStatus(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  coreInstalled() {
    try { return fs.statSync(this.exePath).isFile(); } catch { return false; }
  }

  /**
   * Is a pen tablet PHYSICALLY attached?
   *
   * Two obvious answers are both wrong, measured on this machine with the tablet
   * unplugged:
   *
   *   - GetSystemMetrics(SM_DIGITIZER) still returned 0x88 (EXTERNAL_PEN|READY).
   *     It is sticky: it describes what the machine has supported, not what is
   *     plugged in now, so it can never report a disconnect. This is what the UI
   *     used to use, which is why unplugging changed nothing.
   *   - Raw-input enumeration still listed a digitizer (usage page 0x0D), because
   *     the tablet driver keeps a virtual HID node alive with no hardware behind it.
   *
   * What actually distinguishes them is where the device hangs: a real pen is
   * enumerated on a real bus (USB\, I2C\, ACPI\, BTHENUM\), while a driver's
   * virtual node is ROOT-enumerated (here: HID\PENTABLET&COL03 under
   * ROOT\HIDCLASS\0000). So: present HID device whose hardware ID carries a
   * digitizer/pen usage (UP:000D_U:0001 or _U:0002) AND whose parent is not ROOT\.
   *
   * Costs ~3.4 s, hence the long timeout and the slow poll interval - it runs
   * hidden in the background and callers read the cached `this.tablet`.
   */
  refreshTablet() {
    if (process.platform !== 'win32') {
      this.tablet = { checked: true, pen: null, ready: null, flags: null };
      return Promise.resolve(this.tablet);
    }
    const PS = [
      "$ErrorActionPreference='SilentlyContinue';",
      '$pen=0;',
      'foreach($d in (Get-CimInstance Win32_PnPEntity -Filter "Present=TRUE" |',
      "  Where-Object { $_.PNPDeviceID -like 'HID\\*' -and ($_.HardwareID -join ' ') -match 'UP:000D_U:000[12]' })) {",
      "  $p=(Get-PnpDeviceProperty -InstanceId $d.PNPDeviceID -KeyName 'DEVPKEY_Device_Parent').Data;",
      "  if ($p -and $p -notlike 'ROOT\\*') { $pen=1 }",
      '}',
      '"PEN=$pen"',
    ].join(' ');
    return new Promise((resolve) => {
      let done = false;
      const unknown = { checked: true, pen: null, ready: null, flags: null };
      const finish = (t) => { if (done) return; done = true; this.tablet = t; resolve(t); };
      let out = '';
      let ps;
      try {
        ps = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', PS],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return finish(unknown);
      }
      const kill = setTimeout(() => { try { ps.kill(); } catch {} finish(unknown); }, 12000);
      ps.stdout.on('data', (d) => { out += d; });
      ps.on('error', () => { clearTimeout(kill); finish(unknown); });
      ps.on('close', () => {
        clearTimeout(kill);
        const m = /PEN=(\d)/.exec(out);
        // No marker at all means the probe itself failed. Report UNKNOWN rather
        // than "no tablet" - a false "unplug it and back in" is its own bug.
        if (!m) return finish(unknown);
        const pen = m[1] === '1';
        finish({ checked: true, pen, ready: pen, flags: null });
      });
    });
  }

  /**
   * Append a line to ui.log next to the core's own tracey.log.
   *
   * Launch failures used to be completely invisible: the spawn was fire-and-forget
   * with stdio:'ignore', so "the core did not start" was the only thing anyone could
   * ever observe, whatever the real reason. Every launch attempt is recorded here.
   */
  logUi(line) {
    try {
      const p = path.join(this.dir, 'ui.log');
      // Never let a debug aid grow without bound on a user's machine.
      try { if (fs.statSync(p).size > 64 * 1024) fs.unlinkSync(p); } catch { /* no file yet */ }
      fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging must never break a launch */ }
  }

  /**
   * Launch the core. Resolves { ok, message }.
   *
   * Windows: the core is a signed uiAccess binary. A normal process cannot
   * CreateProcess it directly, so we go through PowerShell's Start-Process,
   * which is what the handoff doc specifies.
   *
   * NEVER pass `detached: true` to that powershell. libuv maps detached to
   * DETACHED_PROCESS, which gives the child NO console — and powershell.exe's
   * ConsoleHost then exits 0 without ever running -Command. Start-Process is
   * never reached, the core never starts, and nothing anywhere reports an error.
   * That was the "the big switch does nothing" bug; measured on this machine as
   * a marker file that a plain spawn writes and a detached spawn never does.
   *
   * Detaching is not needed anyway: Start-Process hands off to AppInfo, which
   * spawns the elevated core as ITS child, so the core outlives both this
   * powershell and the UI. unref() alone keeps the app free to quit.
   *
   * The promise settles when powershell exits, which for an elevated target is
   * only AFTER the user answers the UAC prompt — so a declined prompt reports
   * itself instead of looking like a dead button.
   */
  launchCore(args = []) {
    const exe = this.exePath;
    const done = (res) => {
      this.logUi(`launch [${args.join(' ')}] -> ${res.ok ? 'ok' : 'FAILED'}` +
                 `${res.code ? ' win32=' + res.code : ''}${res.message ? ' : ' + res.message : ''}`);
      return res;
    };

    if (!this.coreInstalled()) {
      return Promise.resolve(done({ ok: false,
        message: `Core not found at ${exe}. Set TRACEY_EXE, or install it with build.ps1.` }));
    }

    if (process.platform !== 'win32') {
      try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
        child.unref();
        return Promise.resolve(done({ ok: true }));
      } catch (err) {
        return Promise.resolve(done({ ok: false, message: `Could not start the core: ${err.message}` }));
      }
    }

    // Process.Start, not Start-Process. Both end up in ShellExecute, which is what
    // AppInfo requires for a uiAccess binary — but Start-Process wraps a failure in
    // an InvalidOperationException that DROPS the Win32 code (verified: no inner
    // exception, HResult is the generic 0x80131509), leaving nothing to identify the
    // failure by except an English sentence. Process.Start throws Win32Exception with
    // NativeErrorCode intact, so the UI can key off the number and still be correct on
    // a non-English Windows. Measured on this machine: a machine that does not trust
    // the signing certificate refuses the launch with 8235 before any prompt appears.
    // .NET Framework's ProcessStartInfo has no ArgumentList, only a single Arguments
    // string; every arg the core takes is a bare flag, so a plain join is safe.
    const script =
      '$psi = New-Object System.Diagnostics.ProcessStartInfo; ' +
      `$psi.FileName = ${psQuote(exe)}; ` +
      `$psi.Arguments = ${psQuote(args.join(' '))}; ` +
      '$psi.UseShellExecute = $true; ' +
      'try { $p = [System.Diagnostics.Process]::Start($psi); "TRACEY_OK " + $p.Id } ' +
      'catch { $c = 0; if ($_.Exception -is [System.ComponentModel.Win32Exception]) ' +
      '{ $c = $_.Exception.NativeErrorCode }; "TRACEY_ERR $c " + $_.Exception.Message; exit 1 }';

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        return resolve(done({ ok: false, message: `Could not start the core: ${err.message}` }));
      }

      let out = '', errText = '', settled = false;
      const finish = (res) => { if (!settled) { settled = true; clearTimeout(guard); resolve(done(res)); } };

      // A UAC prompt the user never answers would otherwise hang this forever,
      // leaving the switch disabled with no way back.
      const guard = setTimeout(() => finish({ ok: false, message:
        'Windows never confirmed the permission prompt. Look for it in the taskbar, then try again.' }),
        LAUNCH_TIMEOUT_MS);

      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { errText += d; });
      child.on('error', (err) => finish({ ok: false, message: `Could not start the core: ${err.message}` }));
      child.on('close', (code) => {
        const text = (out + errText).trim();
        if (/TRACEY_OK/.test(text)) return finish({ ok: true });
        // Numeric form first. The bare form is kept as a fallback so an unexpected
        // shape degrades to the old behaviour instead of falling through to the
        // "PowerShell never ran the script" branch, which would be a lie.
        const m = /TRACEY_ERR\s+(\d+)\s+([\s\S]*)/.exec(text);
        if (m) return finish({ ok: false, code: Number(m[1]),
                               message: describeLaunchError(Number(m[1]), m[2].trim()) });
        const m0 = /TRACEY_ERR\s*([\s\S]*)/.exec(text);
        if (m0) return finish({ ok: false, code: 0, message: describeLaunchError(0, m0[1].trim()) });
        // No marker at all means powershell itself never ran the script.
        finish({ ok: false, message:
          `Windows could not run the start command (PowerShell exited ${code}` +
          `${text ? ': ' + text.slice(0, 200) : ' with no output'}).` });
      });
      child.unref();
    });
  }
}

/** Single-quote for PowerShell: doubling is how a literal quote is escaped there. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/* Win32 codes ShellExecute actually returns on this path. Matching the NUMBER is
   the point: the English-text tests below are only a fallback for the case where
   no code came through, and they are wrong on a localised Windows. */
const E_FILE_NOT_FOUND = 2;      // ERROR_FILE_NOT_FOUND
const E_CANCELLED      = 1223;   // ERROR_CANCELLED - the user answered No to UAC
const E_DS_REFERRAL    = 8235;   // ERROR_DS_REFERRAL - see below

/**
 * Turn a launch failure into something a user can act on.
 *
 * `code` is the Win32 error from ShellExecute, 0 if it could not be recovered.
 * Each branch checks the code first and the message text second.
 */
function describeLaunchError(code, raw) {
  if (code === E_CANCELLED || /canceled by the user|cancelled by the user/i.test(raw)) {
    // Two lines on purpose: what happened, then what to do about it. `.hero-error`
    // is `white-space: pre-line`, so this newline is rendered, not collapsed.
    return 'Windows asked for permission and it was declined.\nTurn Tracey on again and choose Yes.';
  }
  if (code === E_DS_REFERRAL) {
    // 8235 is a nonsense name for this ("a referral was returned from the server"),
    // but it is what Windows returns when it refuses to launch a uiAccess binary
    // whose signature does not chain to a trusted root — MEASURED, by removing the
    // certificate from LocalMachine\Root and launching. This is the single most
    // likely failure on someone else's computer, and it happens BEFORE any prompt:
    // no UAC dialog, no core process, nothing in the core's own log. Without this
    // branch the user got the raw sentence above, which names nothing they can do.
    return "Tracey's security certificate is not installed.\nRun the Tracey installer again to add it.";
  }
  if (code === E_FILE_NOT_FOUND || /cannot find the file/i.test(raw)) {
    return 'Windows refused to start Tracey. If Smart App Control is on, turn it off ' +
           '(Windows Security > App & browser control), then try again.';
  }
  return `Windows could not start Tracey: ${raw}`;
}

function describeWriteError(err, dir) {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    if (process.platform === 'win32') {
      return `Windows blocked writing to ${dir}. Run this once in an admin terminal:\n` +
             `icacls "${dir}" /grant *S-1-5-32-545:(OI)(CI)M`;
    }
    return `No permission to write to ${dir}. Fix the folder permissions or point TRACEY_DIR somewhere you own.`;
  }
  return `Could not write to ${dir} (${err.code}).`;
}

module.exports = { CoreComms, defaultDir, defaultExe, parseCfg, PRESETS, PARAM_RANGES };
