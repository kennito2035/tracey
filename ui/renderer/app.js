'use strict';

const $ = (id) => document.getElementById(id);

const ui = { state: null, fmin: 0.4, beta: 0.02, tremorHz: null, dirty: false, busy: null,
             clearError: null,
             // The card the user last clicked. Only consulted while its values are
             // still the live ones — see matchPreset().
             picked: null,
             // The on/off the user just asked for, held until the core confirms it.
             // status.cfg lags a config write by up to ~200ms (the core's poll), so
             // rendering the status value in that window snapped the switch back to
             // where it started and then forward again.
             pending: null, pendingAt: 0 };

/** Must match CAL_SECONDS in tracey.c, or the progress bar lies about the wait. */
const CAL_SECONDS = 10;

/* ================================================================== theme == */

function applyTheme(mode) {
  const dark = mode === 'dark';
  document.documentElement.dataset.theme = mode;
  // aria-checked drives both the announcement and the thumb position in CSS.
  // The label names the CURRENT state; the tooltip names what a click will do.
  $('themeBtn').setAttribute('aria-checked', String(dark));
  $('themeBtn').setAttribute('aria-label', dark ? 'Dark mode' : 'Light mode');
  $('themeBtn').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  try { localStorage.setItem('theme', mode); } catch {}
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch {}
  // Dark is the product default: this window sits beside a drawing canvas, and a
  // bright panel next to artwork is distracting. A user's own choice still wins.
  applyTheme(saved || 'dark');
})();

$('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ================================================================== writes == */

let writeTimer = null;
function pushParams() {
  ui.dirty = true;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    const res = await window.tracey.setParams({ fmin: ui.fmin, beta: ui.beta });
    if (res && res.ok === false) showWriteError(res.message);
    ui.dirty = false;
  }, 90);
}

function showWriteError(message) {
  $('writeNote').hidden = !message;
  $('writeNote').textContent = message || '';
}

/* ================================================================== render == */

function setHero(title, text) {
  const h = $('heroTitle');
  if (h.textContent !== title && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    h.classList.remove('swap');
    void h.offsetWidth;              // restart the animation
    h.classList.add('swap');
  }
  h.textContent = title;
  $('heroText').textContent = text;
}

function render(s) {
  ui.state = s;
  const st = s.status;
  // !! is load-bearing. status.running and status.enabled are NUMBERS (0/1), so
  // `present && running && enabled` evaluates to 1, and String(1) is "1" - which
  // is not "true". aria-checked="1" matches no CSS rule, so the switch stayed
  // grey and left-hand while Tracey was actually running, and the click handler's
  // `!== 'true'` test always read "off", so it could never be switched back off.
  const actual = !!(st.present && st.running && st.enabled);
  let on = actual;
  // Hold the clicked state until the core agrees, so the switch and the hero move
  // once, on the click, instead of settling in two visible steps. Not held while
  // busy expires: starting the core waits on a UAC prompt that can take seconds.
  if (ui.pending !== null) {
    if (actual === ui.pending || (!ui.busy && Date.now() - ui.pendingAt > 2500)) ui.pending = null;
    else on = ui.pending;
  }

  $('toggle').setAttribute('aria-checked', String(on));
  // The brand mark doubles as a state light, readable from anywhere in the window.
  $('brandMark').className = 'mark ' +
    (!st.present || !st.running ? 'is-off' : on ? 'is-on' : 'is-paused');
  // Usable whenever Tracey is installed: pressing it when nothing is running is
  // what STARTS it. Only a missing install leaves the switch dead.
  // Starting means a UAC prompt and a wait, so hold the switch shut until it
  // resolves - a second click during that window would launch a second core.
  $('toggle').disabled = !!ui.busy || (!s.coreInstalled && !st.present);
  if (st.running) showHeroError(null);          // it worked; clear any stale complaint

  // Plain language only. Never say "core", never show a number here.
  const noPen = s.tablet && s.tablet.checked && s.tablet.pen === false;
  if (ui.busy) {
    // Status pushes land several times a second, so without this the hero would
    // sit on "Tracey is not running" for the whole launch and look like a no-op.
    setHero(ui.busy, 'Windows may ask for permission. Choose Yes.');
  } else if (!st.present || !st.running) {
    // No pen verdict here either, for the same reason the chip is hidden while
    // stopped: this branch runs when no core is up, so the only source is the
    // 20 s-stale fallback probe, and "No pen tablet is connected" is the one
    // message that is actively harmful to get wrong.
    setHero(st.present ? 'Tracey has stopped' : 'Tracey is not running',
            !s.coreInstalled ? 'Tracey is not installed on this computer yet.'
              : 'Turn it on to start steadying your pen.');
  } else if (on) {
    // Reachable now that a disconnect is actually detected: the old check could
    // never go false, so this branch always read "Your pen is steady". Saying
    // that with no tablet attached is simply untrue.
    setHero(noPen ? 'No tablet connected' : 'Your pen is steady',
            noPen ? 'Plug your pen tablet in and Tracey will steady it.'
                  : 'Smoothing your hand in every app on this computer.');
  } else {
    // The title stays "paused" — that state is the user's own doing and hiding it
    // behind a tablet message would be a downgrade. The SUB-text has to carry the
    // tablet fact though: with no pen the two cards below go unselectable, and a
    // control that greys out with no stated cause reads as broken. Reachable only
    // with a live core, so this is the core's reading, not the stale fallback.
    setHero('Tracey is paused',
            noPen ? 'No pen tablet is connected. Plug one in, then turn Tracey on.'
                  : 'Turn it on whenever you want a steadier line.');
  }

  if (!ui.dirty) {
    if (st.fmin !== null) { ui.fmin = st.fmin; $('fmin').value = st.fmin; }
    if (st.beta !== null) { ui.beta = st.beta; $('beta').value = st.beta; }
  }
  // From the PROFILE, not from status.cfg. status's tremor_hz is only a mirror:
  // the core loads profile.cfg into g_notch_seed_hz at STARTUP and the 1 Hz
  // heartbeat republishes that same value forever. So a running core keeps
  // reporting a tremor_hz whose profile.cfg has been deleted — which made
  // "Clear calibration data" grey out Custom while "Set up · 4.0 Hz" stayed on
  // screen. profile.cfg is the thing that actually exists or does not.
  ui.tremorHz = s.profile && s.profile.tremor_hz ? s.profile.tremor_hz : null;

  $('fminOut').textContent = Number(ui.fmin).toFixed(3);
  $('betaOut').textContent = Number(ui.beta).toFixed(4);
  filter.setParams(ui.fmin, ui.beta);

  // No frequency is shown to the user. The reasoning lives once, at the
  // calibration 'done' handler below, so it cannot rot in two places: the short
  // version is that the SHIPPED detector is above chance (AUC 0.754, 95% CI
  // 0.644-0.856) and that is still not enough, because an AUC ranks groups
  // rather than individuals and on the live calibration task it reports a tremor
  // for 3 of 20 steady hands at a clinical-sounding ~5.2 Hz. `tremor_hz` is kept
  // in profile.cfg because --notch (opt-in, experimental) seeds from it; it is a
  // seed, not a claim. ui.tremorHz survives only to drive the practice pad's
  // simulated-shake demo.

  renderPresets(s.presets);

  // No separate "installed but not running" card any more: it restated what the
  // hero already says and gave a second, competing way to start the core. The
  // big switch is the one control that starts Tracey; a missing install is
  // reported in the hero sub-text, its path in the Advanced diagnostics and in
  // the error the failed start returns.
  const coreUp = !!(st.present && st.running);
  $('coreSwitch').setAttribute('aria-checked', String(coreUp));
  $('coreSwitch').disabled = !s.coreInstalled || !!ui.busy;
  $('coreState').textContent = coreUp ? (st.enabled ? 'Running' : 'Running, paused') : 'Not running';
  // Both cards need a LIVE core, not merely an installed one: calibration is
  // driven by the running core, and neither should look available when nothing
  // is there to answer. `coreUp` is present && running, so PAUSED still counts —
  // pausing stops the filtering, not the process, and both remain usable.
  //
  // They also need a pen ATTACHED. Both pads are pen exercises: the wizard is
  // driven entirely by the core's pen samples, so with no tablet it measures ten
  // seconds of nothing and reports a failure the user cannot act on; and the
  // practice pad would invite a mouse doodle to stand as evidence about a pen.
  // `noPen` is `pen === false` and nothing else — pen=-1 is UNKNOWN and must
  // never lock anyone out. Only consulted while coreUp, so the reading is the
  // core's own 0.65 ms native probe on the 1 Hz heartbeat, current within a
  // second, never the UI's 20 s-stale PowerShell fallback.
  const padsReady = coreUp && !noPen;
  $('openCal').disabled = !padsReady;
  $('openTry').disabled = !padsReady;
  // Beckon only when NEVER calibrated, not merely when no tremor was found. A
  // steady hand now legitimately calibrates to tremor_hz = 0 (the floor-shoulder
  // guard in tremor_tracker.h), and pulsing at someone who just finished reads as
  // "that didn't work — do it again".
  $('openCal').classList.toggle('attention', padsReady && !s.profile);

  $('dirPath').textContent = s.paths.dir;
  tag('tagStatus', st.present ? 'ok' : 'bad', st.present ? 'status.cfg found' : 'status.cfg missing');
  tag('tagWrite', s.writable.ok ? 'ok' : 'bad', s.writable.ok ? 'write access' : 'no write access');
  tag('tagCore', s.coreInstalled ? 'ok' : 'warn', s.coreInstalled ? 'core installed' : 'core not found');
  // The removed blocker was the only place the expected exe path was shown, and
  // the main switch is DISABLED when the core is missing -- so the failed-start
  // message that carries the path is unreachable in exactly the case you need it.
  $('tagCore').title = s.paths.exePath;
  // Only claim a tablet state while the core is up (running, or running+paused).
  // The core probes natively on its 1 Hz heartbeat, so that reading is current
  // within a second. With no core the UI falls back to its own PowerShell probe,
  // which costs 3.3 s and is therefore polled every 20 s — so a stopped Tracey
  // would show a verdict up to 20 s out of date. Say nothing rather than that.
  $('tagPen').hidden = !coreUp;
  if (coreUp) {
    const tb = s.tablet || { checked: false, pen: null };
    tag('tagPen',
        !tb.checked ? 'warn' : tb.pen === null ? 'warn' : tb.pen ? 'ok' : 'bad',
        !tb.checked ? 'pen tablet: checking' : tb.pen === null ? 'pen tablet: unknown'
          : tb.pen ? 'pen tablet connected' : 'no pen tablet');
  }
  // A failed clear has to outlive the next status push, which lands within 200ms
  // and would otherwise wipe the only report the user ever sees. A real write
  // problem still wins: it explains the failure.
  showWriteError(!s.writable.ok ? s.writable.message : ui.clearError);
}

function tag(id, cls, text) {
  $(id).className = 'tag ' + cls;
  $(id).textContent = text;
}

/** Apply a smoothing pair to the sliders, the live preview and the core. */
function applyParams(fmin, beta) {
  ui.fmin = fmin; ui.beta = beta;
  $('fmin').value = fmin; $('beta').value = beta;
  $('fminOut').textContent = fmin.toFixed(3);
  $('betaOut').textContent = beta.toFixed(4);
  filter.setParams(fmin, beta);
  pushParams();
}

/**
 * The three named cards plus Custom, all in one row.
 *
 * Custom (id 4) is a real, selectable option that re-applies the saved
 * calibration, not a label. Calibration INTERPOLATES between the three cards,
 * so its result normally sits between two of them and coincides with no card
 * at all; without this card a calibrated profile would leave every card
 * unselected, which reads as "nothing is chosen". It is disabled until a
 * calibration exists for it to apply.
 */
const CUSTOM_ID = 4;

function renderPresets(presets) {
  const host = $('presets');
  const want = presets.length + 1;
  if (host.childElementCount !== want) {
    host.innerHTML = '';
    for (const p of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.dataset.id = String(p.id);
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = p.name;
      b.querySelector('span').textContent = p.hint;
      b.addEventListener('click', () => { ui.picked = p.id; applyParams(p.fmin, p.beta); markPreset(p.id); });
      host.appendChild(b);
    }
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'preset preset-custom';
    c.dataset.id = String(CUSTOM_ID);
    c.innerHTML = '<b>Custom</b><span></span>';
    c.addEventListener('click', () => {
      const pr = ui.state && ui.state.profile;
      if (!pr) return;                      // disabled anyway; belt and braces
      ui.picked = CUSTOM_ID;
      applyParams(pr.fmin, pr.beta);
      markPreset(CUSTOM_ID);
    });
    host.appendChild(c);
  }

  const pr = ui.state && ui.state.profile;
  const custom = host.querySelector('.preset-custom');
  custom.disabled = !pr;
  /* Name the level calibration chose, rather than saying "tuned to your own hand"
   * next to a highlighted card holding the identical numbers. The core now picks
   * from the same three entries as the cards, so the profile always equals one of
   * them, and two cards claiming to be different settings when they are the same
   * setting is the confusion this replaces.
   *
   * The old wording survives as the fallback, and it is not dead code: a profile
   * written before the tables were reconciled holds values matching no card. */
  const chose = pr && presets.find((p) => Math.abs(p.fmin - pr.fmin) < 1e-6 &&
                                          Math.abs(p.beta - pr.beta) < 1e-9);
  custom.querySelector('span').textContent =
    !pr ? 'Calibrate first to unlock'
    : chose ? `Your calibration chose ${chose.name}`
    : 'Tuned to your own hand';
  markPreset(matchPreset(presets));
}

const samePair = (fmin, beta) =>
  Math.abs(fmin - ui.fmin) < 1e-6 && Math.abs(beta - ui.beta) < 1e-9;

/**
 * Which card the live values correspond to; CUSTOM_ID if they are the profile's.
 *
 * A calibration can land on EXACTLY a named preset's pair: a real one here came
 * back fmin 0.400 / beta 0.0200, which is Balanced to the digit. Both cards are
 * then legitimately "current", and the named one won on every status push, so
 * clicking Custom looked like a dead button: it applied the values and the
 * highlight snapped back within 200ms. An explicit click therefore wins for as
 * long as the values it set are still the live ones.
 */
function matchPreset(presets) {
  const stillHolds = (id) => {
    if (id === CUSTOM_ID) {
      const pr = ui.state && ui.state.profile;
      return !!pr && samePair(pr.fmin, pr.beta);
    }
    const p = presets.find((q) => q.id === id);
    return !!p && samePair(p.fmin, p.beta);
  };
  /* A hotkey is an explicit choice of a NAMED preset and the core says so:
   * apply_preset() publishes preset=1..3, while anything set through the UI or
   * loaded from a profile publishes 0 (g_preset = -1). That statement has to
   * beat a sticky ui.picked, and it has to win BEFORE the check below.
   *
   * This only started mattering when the core adopted the UI's preset table.
   * Calibration now lands on EXACTLY one of the three cards, so after clicking
   * Custom the profile and that card are indistinguishable by value, and
   * stillHolds(CUSTOM_ID) stayed true forever: pressing Ctrl+Alt+1 on a hand
   * calibrated to Gentle left Custom lit and Gentle never highlighted, while 2
   * and 3 worked. Adopt the core's answer as the new explicit pick.
   *
   * Only a LIVE core's id means anything. core-comms zeroes `running` for a
   * stale or exited core but passes `preset` straight through, so an id left in
   * status.cfg by Ctrl+Alt+3 outlived the core that published it: the next
   * launch re-selected that card, and because this branch also WRITES
   * ui.picked it overwrote an explicit Custom click on every status push, so
   * the highlight bounced back within a beat. That is the same rule
   * currentParams() already applies to fmin/beta: a status.cfg left behind by a
   * core that stopped is not evidence of anything. */
  const st = ui.state ? ui.state.status : null;
  const coreLive = !!(st && st.running);
  const fromCore = coreLive ? st.preset : null;
  if (fromCore && presets.some((p) => p.id === fromCore) && stillHolds(fromCore)) {
    ui.picked = fromCore;
    return fromCore;
  }

  if (ui.picked && stillHolds(ui.picked)) return ui.picked;

  /* A STOPPED Tracey is applying nothing, so no card describes it and none is
   * highlighted. Everything below reads the live state, and while the core is
   * down that state is a file on disk describing a process that no longer
   * exists. In particular a calibrated profile must NOT light Custom here: it
   * lights when the core has actually started and loaded it, which is after the
   * UAC prompt is accepted, not the moment the profile appears on disk. An
   * explicit click this session still wins, above. */
  if (!coreLive) return 0;

  /* preset=0 is the core stating that these values did NOT come from a named
   * card (g_preset = -1: a calibrated profile, or the sliders). It cannot ride
   * the branch above, because 0 is falsy and no card carries that id, so it has
   * to be tested on its own. It matters because interpolated calibration CLAMPS
   * at both ends: J <= 2 saves exactly Gentle and J >= 6 exactly Steadiest, and
   * the value match below would then light that named card on a hand that had
   * just been calibrated, which is the one moment Custom has to win. Placed
   * AFTER the sticky check so an explicit click on a named card still holds. */
  if (fromCore === 0 && stillHolds(CUSTOM_ID)) {
    ui.picked = CUSTOM_ID;
    return CUSTOM_ID;
  }

  const hit = presets.find((p) => samePair(p.fmin, p.beta));
  if (hit) return hit.id;
  const pr = ui.state && ui.state.profile;
  if (pr && samePair(pr.fmin, pr.beta)) return CUSTOM_ID;
  return 0;   // nothing matches: hand-set on the sliders
}

function markPreset(id) {
  for (const b of document.querySelectorAll('.preset')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.id) === id));
  }
}

/* ================================================================ controls == */

/* Reopening the window always lands on the main switch: scroll to the top and
   collapse Advanced. Only theme and settings are remembered, never view state. */
if (window.tracey.onResetView) {
  window.tracey.onResetView(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('details').forEach((d) => { d.open = false; });
  });
}

function showHeroError(message) {
  $('heroError').hidden = !message;
  $('heroError').textContent = message || '';
}

/**
 * Run a core start/stop, holding the UI in a visible "working" state for the
 * whole round trip. Turning Tracey on can take a UAC prompt plus a few seconds,
 * and a switch that snaps back with no explanation is the thing users read as
 * "the button is broken".
 */
async function withBusy(label, fn) {
  ui.busy = label;
  showHeroError(null);
  if (ui.state) render(ui.state);
  try {
    const res = await fn();
    ui.busy = null;
    // It did not happen; stop pretending it did. Same rule as the pause/resume
    // path, and it is LOAD-BEARING here: render() is the only place `pending`
    // expires, and it only runs when a state push arrives. A declined UAC prompt
    // changes nothing in status.cfg, so no push ever comes -- the optimistic ON
    // stayed on screen indefinitely, above a hero reading "Tracey has stopped".
    // Worse, the next click then read as "turn OFF" (setEnabled(false) launches
    // nothing), so the error's own advice -- turn it on again and choose Yes --
    // could not be followed without clicking twice.
    if (res && res.ok === false) {
      ui.pending = null;
      showHeroError(res.message); showWriteError(res.message);
    }
    if (ui.state) render(ui.state);
    return res;
  } catch (err) {
    ui.busy = null;
    ui.pending = null;
    showHeroError(String(err && err.message ? err.message : err));
    if (ui.state) render(ui.state);
  }
}

$('toggle').addEventListener('click', () => {
  if (ui.busy) return;
  const on = $('toggle').getAttribute('aria-checked') !== 'true';
  const st = ui.state && ui.state.status;
  const coreUp = !!(st && st.present && st.running);

  ui.pending = on;
  ui.pendingAt = Date.now();
  if (ui.state) render(ui.state);      // knob AND hero move on the click, once

  if (coreUp) {
    // Pause/resume is a local config write — setEnabled's `needsLaunch` is false,
    // so it settles in microseconds. Routing it through withBusy put a
    // "Pausing Tracey…" hero in front of the real one, which meant two `.swap`
    // rise animations per toggle: the judder. No busy state for the fast path.
    window.tracey.setEnabled(on).then((res) => {
      if (res && res.ok === false) {
        ui.pending = null;             // it did not happen; stop pretending it did
        showHeroError(res.message);
        if (ui.state) render(ui.state);
      }
    });
  } else {
    // Starting the core is the slow path: a UAC prompt and up to 15 s of waiting.
    // That genuinely needs the busy state or the switch looks dead.
    withBusy('Starting Tracey…', () => window.tracey.setEnabled(on));
  }
});

for (const key of ['fmin', 'beta']) {
  $(key).addEventListener('input', (e) => {
    ui[key] = Number(e.target.value);
    $(key + 'Out').textContent = key === 'fmin' ? ui[key].toFixed(3) : ui[key].toFixed(4);
    filter.setParams(ui.fmin, ui.beta);
    if (ui.state) markPreset(matchPreset(ui.state.presets));
    pushParams();
  });
}

for (const b of document.querySelectorAll('.step')) {
  b.addEventListener('click', () => {
    const el = $(b.dataset.target);
    const next = Math.min(Number(el.max), Math.max(Number(el.min),
      Number(el.value) + Number(el.step) * Number(b.dataset.dir)));
    el.value = next;
    el.dispatchEvent(new Event('input'));
  });
}

$('coreSwitch').addEventListener('click', () => {
  if (ui.busy) return;
  const up = $('coreSwitch').getAttribute('aria-checked') === 'true';
  withBusy(up ? 'Stopping Tracey…' : 'Starting Tracey…',
           () => (up ? window.tracey.stopCore() : window.tracey.startCore()));
});
$('openFolder').addEventListener('click', () => window.tracey.openFolder());

/* Throws the calibration away for good: the files, the wizard's scribble, and the
   Custom card with them, dropping back to Balanced. Deliberately NOT behind a
   confirm — losing it costs a ten-second scribble, and the button says exactly
   what it does. The practice pad is untouched; it is not calibration. */
$('clearCal').addEventListener('click', async () => {
  const btn = $('clearCal');
  btn.disabled = true;
  try {
    const res = await window.tracey.clearCalibration();
    ui.clearError = res && res.ok === false ? res.message : null;
    // The wizard keeps its result in memory, so the files going away is not
    // enough — reset it here or reopening it would show the cleared scribble.
    lastCal = null;
    livePath = [];
    pathOrigin = null;
    resetCal();
    if (calDlg.open) livePlot();
    render(await window.tracey.getState());
  } finally {
    btn.disabled = false;
  }
});

/* ============================================================ practice pad == */

const tryDlg = $('tryDialog');
const canvas = $('trace');
let ctx = canvas.getContext('2d');
const filter = new OneEuro2D(ui.fmin, ui.beta);

let strokes = [];
let current = null;
let drawing = false;
let simPhase = 0;

function fitCanvas(el) {
  const dpr = window.devicePixelRatio || 1;
  const r = el.getBoundingClientRect();
  el.width = Math.round(r.width * dpr);
  el.height = Math.round(r.height * dpr);
  const c = el.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return c;
}

function inkFor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* Both pads' scribbles outlive the app: the practice strokes until Clear is
   pressed, the calibration stroke until the next calibration replaces it. Points
   are rounded to 0.1 px -- finer than either pad can render -- because the raw
   float text is about three times the size for no visible difference. */
const PAD_MAX_POINTS = 20000;   // ~100 s of pen at 200 Hz; a hard ceiling on the file

/* null entries are the calibration path's pen-up markers and must survive the
   round trip through pad-state.json — destructuring one would throw. */
function r1(pts) {
  return pts.map((p) => (p ? [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] : null));
}

function savePad() {
  window.tracey.setPadState({
    strokes: strokes.map((s) => ({ raw: r1(s.raw), filt: r1(s.filt) })),
    lastCal: lastCal
      ? { path: r1(lastCal.path), msg: lastCal.msg, hz: lastCal.hz, origin: lastCal.origin || null }
      : null,
  });
}

/** Drop the oldest strokes once the pad holds more than the file should carry.
 *  The newest stroke is always kept, however long it is. */
function trimStrokes() {
  let total = strokes.reduce((n, s) => n + s.raw.length, 0);
  while (strokes.length > 1 && total > PAD_MAX_POINTS) total -= strokes.shift().raw.length;
}

/** The prompt is a prompt for an EMPTY pad. It goes when the first stroke starts
 *  and stays gone while any ink is on the pad -- it comes back only on Clear, so
 *  it never sits on top of a drawing you are still looking at. */
function traceHint() {
  $('canvasHint').hidden = strokes.length > 0;
}

$('openTry').addEventListener('click', () => {
  tryDlg.showModal();
  ctx = fitCanvas(canvas);
  traceHint();
  redraw();
});
$('tryClose').addEventListener('click', () => tryDlg.close());
$('clearTrace').addEventListener('click', clearTrace);

function pointFrom(e) {
  const r = canvas.getBoundingClientRect();
  let x = e.clientX - r.left;
  let y = e.clientY - r.top;
  if ($('simShake').checked) {
    const hz = ui.tremorHz || 6.0;
    simPhase += 0.055;
    x += Math.sin(simPhase * hz) * 3.6;
    y += Math.cos(simPhase * hz * 1.13) * 3.6;
  }
  return [x, y];
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drawing = true;
  filter.reset();
  const [x, y] = pointFrom(e);
  current = { raw: [[x, y]], filt: [filter.filter(x, y, e.timeStamp / 1000)] };
  strokes.push(current);
  traceHint();
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const evts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evts) {
    const [x, y] = pointFrom(ev);
    current.raw.push([x, y]);
    current.filt.push(filter.filter(x, y, ev.timeStamp / 1000));
  }
  redraw();
});

// pointerleave is deliberately absent: under pointer capture it would cut the
// line mid-scribble, on exactly the fast movement this app exists for.
for (const evt of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(evt, () => {
    drawing = false; current = null;
    // The prompt deliberately does NOT come back here: the pad still has ink on
    // it, and a prompt over a finished drawing reads as though the drawing did
    // not register. Clear is what empties the pad, so Clear is what restores it.
    trimStrokes();
    savePad();
  });
}

function polyline(c, pts, color, width, alpha) {
  if (pts.length < 2) return;
  c.globalAlpha = alpha;
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.stroke();
  c.globalAlpha = 1;
}

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

function redraw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const shake = inkFor('--shake-stroke');
  const steady = inkFor('--steady');
  let rawTotal = 0, filtTotal = 0;
  for (const s of strokes) {
    polyline(ctx, s.raw, shake, 2, 0.55);
    polyline(ctx, s.filt, steady, 4, 1);
    rawTotal += pathLength(s.raw);
    filtTotal += pathLength(s.filt);
  }
  const pct = rawTotal > 4 ? Math.max(0, (1 - filtTotal / rawTotal) * 100) : null;
  $('mReduce').textContent = pct === null ? '—' : `${pct.toFixed(0)}%`;
}

function clearTrace() {
  strokes = [];
  current = null;
  filter.reset();
  traceHint();
  $('mReduce').textContent = '—';
  savePad();
  redraw();
}

/* ============================================================= calibration == */

const calDlg = $('calDialog');
const calCanvas = $('calCanvas');
let calCtx = null;
/* The calibration pad is a DISPLAY, not a sketchpad. It shows the stroke the
   core measured and nothing else — doodling on it beforehand only invited the
   question of whether that doodle counted towards the measurement. It never
   did, which is exactly why it should not have been drawable. */
let livePath = [];        // PHYSICAL screen pixels, as the core recorded them
let calRecording = false; // true between Start and done/error
// Screen position of the web content area, in CSS pixels. Owned by the main
// process (see 'tracey:content-origin'); refreshed whenever the window moves,
// because a stale origin offsets the whole scribble.
let winOrigin = { x: 0, y: 0 };
/* A FINISHED scribble is a record of where the pen went, not a live view, so it
   is pinned to the origin it was captured at. Without this it would slide across
   the pad when the window moved, and a stroke restored from a previous session --
   where the window sat somewhere else entirely -- could replay clean off the
   canvas and look like the scribble had been lost. null => live, use winOrigin. */
let pathOrigin = null;

/** A parked (minimized/hidden) window reports a position near -32000 on Windows.
 *  One pinned into a saved scribble draws it tens of thousands of px off the pad,
 *  so a stored origin is trusted only if it could be a real screen position; the
 *  live origin is used instead, which is what an unpinned path already does. */
function saneOrigin(o) {
  return o && Math.abs(o.x) < 20000 && Math.abs(o.y) < 20000 ? o : null;
}
window.tracey.onWindowOrigin((o) => {
  winOrigin = o;
  if (calDlg.open) livePlot();
});

/**
 * Draw the scribble 1:1 under the pen — the same behaviour as the practice pad.
 *
 * The practice pad feels right because it does nothing clever: a pointer event
 * at a screen position draws at that position inside the canvas. This now does
 * exactly the same, just via the core instead of pointer events (the core has
 * the pen captured, so no events reach this canvas).
 *
 * Two earlier attempts were both wrong. Mapping the whole virtual desktop onto
 * the pad made a scribble draw at ~10% size in the middle. Auto-fitting the
 * path's bounding box filled the pad but changed the scale as the stroke grew,
 * so the drawing never sat still under the hand. No scaling and no centring
 * removes both problems: the pen draws where it points.
 *
 * The core reports PHYSICAL pixels and the DOM works in CSS pixels, so divide
 * by devicePixelRatio — at 125% scaling those differ and the stroke would land
 * a quarter too far across the screen. Anything drawn outside the canvas is
 * clipped by the canvas itself, again exactly like the practice pad.
 *
 * The canvas origin comes from the MAIN process, not from `window.screenX/Y`.
 * Chromium reports those for the OUTER window, so on a framed window they sit a
 * title bar above the viewport — and every plotted point landed that far DOWN
 * the pad, which is the offset that made the scribble hang below the pen.
 * `getContentBounds()` is the viewport rectangle by definition.
 */
function livePlot() {
  if (!calCtx) calCtx = fitCanvas(calCanvas);
  const r = calCanvas.getBoundingClientRect();
  calCtx.clearRect(0, 0, r.width, r.height);
  calHint();
  if (livePath.length < 2) return;

  // Canvas origin in SCREEN CSS pixels: the content area's screen position plus
  // the canvas's offset inside it — the same frame the core's points live in,
  // once scaled out of physical pixels.
  const dpr = window.devicePixelRatio || 1;
  const org = pathOrigin || winOrigin;
  const ox = org.x + r.left;
  const oy = org.y + r.top;

  // One polyline PER STROKE. `null` is the core's pen-up marker; drawing the
  // whole path as a single line joined the end of one stroke to the start of the
  // next with a straight line the user never drew.
  const ink = inkFor('--shake-stroke');
  let seg = [];
  const flush = () => { if (seg.length >= 2) polyline(calCtx, seg, ink, 2.5, 0.9); seg = []; };
  for (const p of livePath) {
    if (!p) { flush(); continue; }
    seg.push([p[0] / dpr - ox, p[1] / dpr - oy]);
  }
  flush();
}

/** Same rule as the practice pad: a prompt for an EMPTY pad. Hidden while the
 *  core is recording and while any measured stroke is on screen; it returns only
 *  when the next calibration starts from nothing. */
function calHint() {
  $('calHint').hidden = calRecording || livePath.length > 0;
}

$('openCal').addEventListener('click', openCal);
$('calClose').addEventListener('click', () => { if (!calRecording) calDlg.close(); });
// Escape closes a <dialog> for free, which would bypass the disabled Close
// button and abandon the wizard mid-measurement.
calDlg.addEventListener('cancel', (e) => { if (calRecording) e.preventDefault(); });
window.tracey.onOpenCalibration(openCal);

/* The last finished calibration, kept so closing and reopening the wizard does
   not throw away what it just told you. Nothing is more annoying than losing
   the reading because you closed the box to look at your drawing. */
let lastCal = null;   // { path, resultText, msg }

async function openCal() {
  if (lastCal) restoreCal(); else resetCal();
  calDlg.showModal();
  calCtx = fitCanvas(calCanvas);
  livePlot();          // repaint the kept scribble at the new canvas size
  // Pull the origin straight from the main process rather than trusting whatever
  // the last `move` push left behind: the window may have been hidden to the tray
  // or minimized since, and the wizard is about to pin this value into a saved
  // scribble. Repaint after, in case it moved.
  winOrigin = await window.tracey.contentOrigin();
  livePlot();
}

function resetCal() {
  livePath = [];
  pathOrigin = null;
  calRecording = false;
  $('calProgress').hidden = true;
  $('calFill').style.width = '0%';
  $('calResult').hidden = true;
  $('calMsg').textContent = 'Press Start when you are ready.';
  $('calRecord').disabled = false;
  $('calRecord').textContent = 'Start';
  $('calClose').disabled = false;
  setStep(1);
}

/** Put the previous result back on screen: the scribble and the closing message.
 *  No frequency: see the note in the status handler. */
function restoreCal() {
  calRecording = false;
  livePath = lastCal.path;
  pathOrigin = saneOrigin(lastCal.origin);
  $('calProgress').hidden = false;
  $('calFill').style.width = '100%';
  $('calProgress').setAttribute('aria-valuenow', '100');
  $('calResult').hidden = true;
  $('calResult').textContent = '';
  $('calMsg').textContent = lastCal.msg;
  $('calRecord').disabled = false;
  $('calRecord').textContent = 'Do it again';
  $('calClose').disabled = false;
  setStep(4);                  // a restored result is a finished one
}

/** n = the step in progress; n > 3 means the whole wizard is finished, which is
 *  the only state where step 3 is itself complete rather than pending. */
function setStep(n) {
  for (const li of $('calSteps').children) {
    const i = Number(li.dataset.step);
    li.className = i < n ? 'done' : i === n ? 'on' : '';
  }
  // "learns" is a promise while the wizard runs; once it has run it is a fact.
  $('calStep3').textContent = n > 3 ? 'Tracey learned your shake' : 'Tracey learns your shake';
}

/* No pointer handlers on this canvas by design — see the note by livePath.
   The practice pad is where you draw; this one only ever shows what the core
   measured. */

$('calRecord').addEventListener('click', async () => {
  $('calRecord').disabled = true;
  $('calResult').hidden = true;
  $('calProgress').hidden = false;
  $('calMsg').textContent = 'Getting Tracey ready…';
  // Authoritative origin before a run that will pin it into the saved scribble.
  winOrigin = await window.tracey.contentOrigin();
  // Clear the pre-start doodle and the previous run, so the new stroke starts
  // on an empty pad.
  livePath = [];
  lastCal = null;
  pathOrigin = null;        // live again: track the window until this one finishes
  calRecording = true;
  // Closing mid-measurement would leave the core recording with nothing showing
  // it; the wizard is not cancellable, so do not offer a door.
  $('calClose').disabled = true;
  livePlot();
  setStep(2);

  const res = await window.tracey.calibrate();
  if (res && res.ok === false) {
    $('calProgress').hidden = true;
    $('calMsg').textContent = res.message;
    $('calRecord').disabled = false;
  }
});

window.tracey.onCalibration((p) => {
  // No 'stopping'/'restoring' phases any more: the live core measures in place
  // rather than being stopped and relaunched, so there is nothing to restore.
  if (p.phase === 'starting') {
    $('calMsg').textContent = 'Getting Tracey ready…';
  } else if (p.phase === 'recording') {
    // The core sends the whole path each tick, so replace rather than append.
    if (p.path) { livePath = p.path; livePlot(); }
    const pct = Math.min(100, ((p.elapsed || 0) / (CAL_SECONDS * 1000)) * 100);
    $('calFill').style.width = pct + '%';
    $('calProgress').setAttribute('aria-valuenow', String(Math.round(pct)));
    // Nothing is drawn on screen while the core measures, so the sample count is
    // the only honest evidence the pen is being seen. Without it, someone whose
    // pen is not registering watches a full bar and learns nothing until the end.
    const n = p.samples;
    $('calMsg').textContent =
      n > 0 ? `Keep scribbling — Tracey can see your pen (${n} points).`
      : (p.elapsed || 0) > 2000
        ? 'Tracey is not seeing your pen yet. Keep its tip on the tablet and keep moving.'
        : 'Keep scribbling on your tablet until the bar fills.';
  } else if (p.phase === 'done') {
    calRecording = false;
    calHint();                 // stroke finished: the prompt comes back
    $('calClose').disabled = false;
    setStep(4);                // finished: step 3 is complete too, not in progress
    $('calFill').style.width = '100%';
    $('calProgress').setAttribute('aria-valuenow', '100');
    $('calRecord').disabled = false;
    $('calRecord').textContent = 'Do it again';
    // NO FREQUENCY IS SHOWN, whatever the core measured. The reason is NOT that
    // the detector is useless - it used to be, and that justification is stale.
    // Before the 2.5 Hz high-pass it scored AUC 0.36-0.40, at or below chance.
    // The detector that SHIPS scores 0.754 (95% CI 0.644-0.856) on 61 PD + 15
    // controls, with the whole interval clear of 0.5.
    //
    // Two reasons survive that improvement. An AUC ranks two GROUPS: it says a
    // random patient tends to outscore a random control, and says nothing about
    // whether one person's reading is their tremor frequency, which is exactly
    // what a number on this screen would assert. And on THIS task, a free
    // scribble at ~250 Hz rather than a spiral at 111, it still reports a tremor
    // for 3 of 20 recordings from a hand that has none, at a clinical-sounding
    // ~5.2 Hz. Telling a steady-handed person they have a 5.2 Hz tremor is a harm
    // no amount of ranking accuracy buys back.
    //
    // ui.tremorHz is still kept: it seeds the practice pad's simulated shake and
    // the opt-in --notch mode. It is a seed, not a claim.
    //
    // The smoothing is chosen from the AMPLITUDE of the scribble, which always
    // succeeds, so this always reads as success. Never as a failure.
    if (p.tremor_hz) ui.tremorHz = p.tremor_hz;
    $('calResult').hidden = true;
    $('calResult').textContent = '';
    $('calMsg').textContent = 'Smoothing is now tuned to your hand. Close this and try the practice pad.';
    // Keep the scribble so reopening the wizard shows it again instead of a
    // blank pad. hz is still stored, but only so restoreCal() and the practice
    // pad have the seed; nothing renders it.
    pathOrigin = saneOrigin({ x: winOrigin.x, y: winOrigin.y });
    lastCal = { path: livePath.slice(), msg: $('calMsg').textContent, hz: p.tremor_hz || 0, origin: pathOrigin };
    savePad();                 // survives a full quit, until the next calibration
  } else if (p.phase === 'error') {
    calRecording = false;
    calHint();
    $('calClose').disabled = false;
    $('calProgress').hidden = true;
    $('calRecord').disabled = false;
    $('calMsg').textContent = p.message;
    // Start already discarded the previous scribble; persist that so disk and
    // screen agree rather than resurrecting it on the next launch.
    savePad();
  }
});

/* =============================================================== scrollbar == */
/* Drives the element that replaced the native scrollbar: size and position the
   thumb from the scroll offset, fade the whole thing in while the page moves
   and out ~900ms after it settles, and let it be dragged. */

(function customScrollbar() {
  const bar = $('scrollbar');
  const thumb = $('scrollThumb');
  const MIN_THUMB = 36;        // never shrink below a grabbable size
  const IDLE_MS = 900;
  let hideTimer = null;
  let dragging = false;
  let grabOffset = 0;

  const overflow = () => document.documentElement.scrollHeight - window.innerHeight;

  function layout() {
    const over = overflow();
    if (over <= 1) { bar.hidden = true; return; }
    bar.hidden = false;
    const track = bar.clientHeight;
    // Bail rather than compute from a track that has no height yet. Observers can
    // fire before the fixed element is laid out, and doing the maths anyway pins
    // the thumb at MIN_THUMB - a stubby 36px handle on a page that barely
    // overflows, which is what happened before this guard.
    if (track <= MIN_THUMB) return;
    const h = Math.max(MIN_THUMB, Math.round((window.innerHeight / document.documentElement.scrollHeight) * track));
    const y = (track - h) > 0 ? Math.round((window.scrollY / over) * (track - h)) : 0;
    thumb.style.height = h + 'px';
    thumb.style.transform = `translateY(${y}px)`;
  }


  function idleHide() {
    clearTimeout(hideTimer);
    if (dragging) return;
    hideTimer = setTimeout(() => bar.classList.remove('on'), IDLE_MS);
  }

  function show() {
    layout();
    if (bar.hidden) return;
    bar.classList.add('on');
    idleHide();
  }

  window.addEventListener('scroll', show, { passive: true });
  window.addEventListener('resize', show);

  // The Advanced panel is the one thing that changes page height without a
  // scroll or a resize, and <details> fires `toggle` synchronously - so drive
  // the measurement from that directly. ResizeObserver stays as a safety net
  // for anything else that grows the page (an error line appearing, say), but
  // it cannot be the only path: its callbacks are delivered during the
  // rendering steps, exactly like requestAnimationFrame, so both go silent
  // whenever the window is not compositing and the thumb freezes at its old
  // size. Neither is called through rAF for the same reason.
  for (const d of document.querySelectorAll('details')) d.addEventListener('toggle', show);
  if (window.ResizeObserver) new ResizeObserver(() => layout()).observe(document.body);

  bar.addEventListener('pointerenter', () => { if (!bar.hidden) { bar.classList.add('on'); clearTimeout(hideTimer); } });
  bar.addEventListener('pointerleave', idleHide);

  function scrollToThumbTop(clientY) {
    const track = bar.clientHeight;
    const h = thumb.offsetHeight;
    const top = bar.getBoundingClientRect().top;
    const y = Math.min(track - h, Math.max(0, clientY - top - grabOffset));
    window.scrollTo(0, (y / (track - h)) * overflow());
  }

  thumb.addEventListener('pointerdown', (e) => {
    dragging = true;
    grabOffset = e.clientY - thumb.getBoundingClientRect().top;
    thumb.setPointerCapture(e.pointerId);
    bar.classList.add('on', 'dragging');
    clearTimeout(hideTimer);
    e.preventDefault();
  });

  thumb.addEventListener('pointermove', (e) => { if (dragging) scrollToThumbTop(e.clientY); });

  for (const evt of ['pointerup', 'pointercancel']) {
    thumb.addEventListener(evt, () => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      idleHide();
    });
  }

  // Clicking the empty track jumps the thumb to the pointer, centred on it.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target === thumb) return;
    grabOffset = thumb.offsetHeight / 2;
    scrollToThumbTop(e.clientY);
    show();
  });

  layout();
  window.__scrollbarLayout = layout;   // re-measured after the first render
})();

/* ==================================================================== boot == */

window.addEventListener('resize', () => {
  if (tryDlg.open) { ctx = fitCanvas(canvas); redraw(); }
  if (calDlg.open) { calCtx = fitCanvas(calCanvas); }
});

window.tracey.onState(render);

/* ------------------------------------------------------------ feedback -- */

function addRipples(selector) {
  for (const el of document.querySelectorAll(selector)) {
    el.classList.add('rippled');
    el.addEventListener('pointerdown', (e) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const r = el.getBoundingClientRect();
      const d = Math.max(r.width, r.height) * 2.2;
      const sp = document.createElement('span');
      sp.className = 'ripple';
      sp.style.width = sp.style.height = d + 'px';
      sp.style.left = (e.clientX - r.left - d / 2) + 'px';
      sp.style.top = (e.clientY - r.top - d / 2) + 'px';
      el.appendChild(sp);
      sp.addEventListener('animationend', () => sp.remove());
    });
  }
}

// The big switch keeps overflow visible so its glow can breathe;
// its feedback is the spring + press scale, not a ripple.
addRipples('.card, .preset, .primary, .soft, .step');
// presets render later, so catch them as they appear
new MutationObserver(() => addRipples('.preset:not(.rippled)'))
  .observe($('presets'), { childList: true });

(async () => {
  // The content origin must be known before the calibration pad plots anything,
  // and the pads' scribbles are restored before either dialog can be opened.
  winOrigin = await window.tracey.contentOrigin();

  // A restore failure must never cost the user the whole UI: everything below --
  // render(), the first scrollbar measurement -- lives in this same async block,
  // so an uncaught throw here would leave the window frozen on "Getting ready…".
  // A lost scribble is an annoyance; a dead window is the app not working.
  try {
    const pad = await window.tracey.getPadState();
    if (pad && Array.isArray(pad.strokes)) {
      strokes = pad.strokes.filter((s) => s && Array.isArray(s.raw) && Array.isArray(s.filt));
    }
    if (pad && pad.lastCal && Array.isArray(pad.lastCal.path)) {
      lastCal = pad.lastCal;
      livePath = lastCal.path;
      pathOrigin = saneOrigin(lastCal.origin);
    }
  } catch { /* start with empty pads rather than no window */ }
  traceHint();
  // Restoring costs two IPC round trips, and a pad opened inside that window
  // would paint itself EMPTY and never repaint -- nothing calls redraw() again
  // until the next stroke, so the scribble would look permanently lost. Repaint
  // whatever is already on screen the moment the data lands.
  if (tryDlg.open) redraw();
  if (calDlg.open) { if (lastCal) restoreCal(); livePlot(); }

  render(await window.tracey.getState());
  // The presets render here for the first time, so the page only reaches its
  // real height now. ResizeObserver catches it, but measure once explicitly so
  // there is no frame where the scrollbar thinks nothing overflows.
  if (window.__scrollbarLayout) window.__scrollbarLayout();
})();
