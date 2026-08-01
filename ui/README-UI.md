# Tracey UI

Tray app, settings window, and calibration wizard for tracey. The UI half of
the project. Nothing here touches `src/`: the core is a separate process and
this talks to it only through `config.cfg` and `status.cfg`.

## Run it

```
npm install
npm start
```

That's it. No bundler, no compiler, no Rust toolchain: Electron plus plain
HTML/CSS/JS, so a fresh clone is running in about a minute.

## Verify the contract

```
npm run verify
```

78 checks of the UI's side of the control channel against the mock core, in a
scratch temp folder. Expect `78 passed, 0 failed`. Fourteen of them are a matrix
over `matchPreset()`, extracted live out of `app.js`: three shipped defects have
come out of that one function, so it is no longer spot-checked. Six more pin the
practice pad's one-euro filter to the core's exact variant (velocity from the
previous filtered output), over both a clean stroke and a coalesced one that
repeats timestamps, so the pad cannot drift canonical again. Eight more freeze
the status.cfg torn-read window (empty, keyless, transient-error, stale and
deleted reads), so one bad read can never again report a live core as stopped.

```
node tools/audit.js
```

(No npm script for this one, deliberately: it reads `../src/tracey.c` and the
second UI tree, so it is not a package-scoped task.) Cross-layer consistency,
which no unit test can see: the keys the C core writes
against the ones the UI parses against the ones the **mock** emits (a drifted
mock means the suite tests a contract nobody speaks), DOM ids against markup,
preload against ipcMain in both directions, dead CSS, `hidden`-toggled elements
against author `display` rules, `CAL_SECONDS` agreement across C and JS, and
that every duplicated file is byte-identical. Run it after any change that
crosses the core/UI boundary.

## Try it without the real core

The UI cannot tell a real core from a fake one, because the only thing it ever
sees is two text files. So test against the mock:

```
# terminal 1: pretend to be tracey.exe
set TRACEY_DIR=%USERPROFILE%\tracey-mock
npm run mock

# terminal 2: the UI, pointed at the same folder
set TRACEY_DIR=%USERPROFILE%\tracey-mock
set TRACEY_EXE=%CD%\tools\mock-core.cmd
npm start
```

Now the toggle, both sliders, the presets, and the calibration wizard all work
end to end. Calibration runs for **ten seconds** (`CAL_SECONDS`, and `app.js`
must agree with `tracey.c` or the progress bar lies about the wait), exactly like
the real thing.

It reports **no tremor frequency**, and neither does the real core. That is
deliberate, not missing: see `ACCESSIBILITY.md`. The measured frequency exists
only to seed the experimental `--notch` mode.

`TRACEY_DIR` is the only way to point the app at another folder. The Settings
group has **Open folder** and nothing else: "Choose folder" and "Use default"
were removed along with their whole IPC chain, because the core reads one fixed
machine-wide path and a UI-side override could only ever disagree with it.

## Run it against the real core

Install the core with `src/build.ps1`, then just `npm start`. Defaults
already match the handoff contract:

| | path |
|---|---|
| settings folder | `%PROGRAMDATA%\Tracey\` |
| core binary | `%ProgramFiles%\Tracey\tracey-core.exe` |

Override either with `TRACEY_DIR` and `TRACEY_EXE`.

**Two names, on purpose.** The installer ships the core as `tracey-core.exe`
while `build.ps1`'s development install writes `tracey.exe`, and Windows is
case-insensitive, so a core named `tracey.exe` and the Electron `Tracey.exe`
cannot coexist in one folder. `defaultExe()` therefore looks **beside the running
UI first**, and checks `tracey-core.exe` before `tracey.exe`, so an installed app
and a dev build both resolve correctly.

If Smart App Control blocks `tracey.exe`, turn it off: Windows Security → App &
browser control → Smart App Control → Off. It's a one-way change.

## The contract, as implemented

The UI **writes** `config.cfg`:

```
enabled=1
fmin=0.4000
beta=0.02000
```

Written to a temp file and renamed, so the core polling at ~5 Hz can never read
a half-written file. Values are clamped to `fmin` 0.15–1.0 and `beta` 0.007–0.08
before they're written.

**The precision is load-bearing.** The core publishes `%.4f` fmin and `%.5f` beta,
so this file must carry the same. It used to write 3 and 4 decimals, which is
exactly lossless for the three named presets and lossy for anything else. That
went unnoticed until calibration began interpolating between them: a measured
`0.5365` came back `0.536`, the core adopted a pair that no longer equalled
`profile.cfg`, and the Custom card deselected itself one push after being clicked.

The UI **reads** `status.cfg` for `running`, `enabled`, `fmin`, `beta`, `preset`,
`tremor_hz`, `calibrating`, `cal_hz`, `cal_samples`, `pen` and `heartbeat`.
`preset=0` means custom. Parsing tolerates comments, blank lines, stray
whitespace, and uppercase keys.

**Calibration runs IN-PROCESS**, in the core that is already filtering:

```
config calibrate=1 -> wait calibrating=1 -> rewrite config WITHOUT the key
                   -> wait calibrating=0 -> read cal_hz
```

**Zero UAC prompts.** The earlier flow stopped the core, launched `--calibrate`
and relaunched the filter, and every launch of a uiAccess binary goes through
AppInfo and costs a prompt, so measuring a tremor charged the user two. Read the
result from `cal_hz`, which is latched, and not from `tremor_hz`, which the 1 Hz
heartbeat keeps rewriting and would race the read. `calibrate` is one-shot like
`quit`: leave it in the file and the next slider write starts another ten-second
measurement under the user's hands.

**Liveness.** The core rewrites `status.cfg` once a second and bumps `heartbeat`.
A hard kill cannot run the clean-exit `running=0` write, so treat `running=1`
plus a file older than ~3 s as dead. Otherwise the UI reports "steady" while the
pen is unfiltered.

## Stopping vs pausing

`enabled=0` pauses the core but leaves it running. `quit=1` stops it: the
process exits. Because a stale `quit=1` would make the next launched core exit
immediately, every ordinary write from the UI omits the key, which clears it.

The main window's big switch starts the core if it is not running, and PAUSES it
from then on: it writes `enabled=0`, never `quit=1`, so the process stays up and
resuming costs no UAC prompt. Stopping it outright lives in the Advanced panel's
second switch (`#coreSwitch`), in the tray's Quit, and in app shutdown. The
window's own help text says the same thing, so a doc that said "starts and stops"
contradicted both the code and the screen. The tray, which exists only while the core
does, offers **Steady my pen**, **Pause Tracey**, **Calibrate my tremor…**, then
**Open Tracey**, **Open settings folder** and **Quit Tracey**.

The UI **never** writes `config.cfg` from the core side and the core never writes
it at all: the core runs elevated, and a config file owned by an elevated process
cannot be overwritten by the non-elevated UI, which would kill every slider
silently.

## Notes from integration (23 Jul)

The core refuses `--calibrate` while a filter instance is up, so calibration
drives it in-process instead of launching a second one. Folder permissions are verified working, with
`build.ps1` granting Users Modify as insurance. The core has a single-instance
mutex, so pressing Start twice is safe.

## Layout

```
electron/
  main.js         tray, windows, calibration state machine, IPC
  preload.js      the only bridge into the renderer
  core-comms.js   per-OS paths, cfg read/write, watching, core launch
renderer/
  index.html      structure
  styles.css      tokens and layout
  app.js          state, controls, live trace, wizard
  oneeuro.js      preview filter only; the C version is the source of truth
tools/
  mock-core.js    stand-in for the core (mock-core.cmd / .sh wrap it)
  verify.js       the 78-check contract suite (npm run verify)
  audit.js        cross-layer consistency (node tools/audit.js)
  prepare-core.js stages the signed core + .cer into build/core/ before packing;
                  refuses to build if the core is missing or unsigned
  make_icons.py   regenerates tray icons (npm run icons)
build/
  installer.nsh   NSIS hooks: certificate import, ProgramData ACL, taskkill
  icon.ico        hand-built 16..256; electron-builder's PNG conversion emitted
                  a single 256px entry and Windows downscaled it badly
  CERTIFICATE_NOTICE.txt  the installer's consent page
  core/           the signed core, staged here by prepare-core.js at pack time
```
`build/` is installer CONFIG, not build output. Watch `.gitignore`: a bare
`build/` rule matches at any depth and will silently exclude all of it.

`core-comms.js` is the whole per-OS surface. When the macOS and Linux control
channels land, `defaultDir()` and `launchCore()` are the only functions that
change.

## Accessibility

This is assistive tech, so the UI is built for hands that shake: every target is
at least 44px, both sliders have large `−`/`+` steppers so nobody has to land a
drag precisely, three named presets plus Custom cover the common cases with one
click, every text and control colour clears WCAG AA with body text at AAA (the
per-pair numbers are in ACCESSIBILITY.md; the lowest is 4.9:1, not the 6:1 this
paragraph used to claim), the whole app is keyboard-navigable with visible
focus, status changes announce through `aria-live`, and animation drops out
under `prefers-reduced-motion`, pseudo-elements included.

## Demo notes

The drawing pad shows raw input in amber under filtered output in teal: the
before/after the pitch is built on, live and interactive. The checkbox labelled
**"Pretend my hand shakes"** (`#simShake`) injects synthetic shake so the
difference is visible even with a steady hand; turn it off when demoing with a
real user. Quote the label as it ships: this file called it "Simulate a tremor"
until 2026-07-30, and a demo script written against a control that does not exist
under that name wastes a take.

The percentage under the pad is path-length reduction in this preview window
only. Do not quote it as a result: the real number is in `VALIDATION.md`
(~19% of the 4–8 Hz clinical tremor band removed at Steadiest, 61 patients
and 15 controls). Note that VALIDATION's 10% row is TOTAL path length
including the spiral itself, which that document explicitly warns against
quoting as shake removed.
