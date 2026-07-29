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

16 checks of the UI's side of the control channel against the mock core, in a
scratch temp folder. Expect `16 passed, 0 failed`.

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
end to end. Calibration takes five seconds and reports a tremor frequency,
exactly like the real thing.

You can also skip the environment variables and use **Choose folder…** in the
app's bottom panel to point it anywhere.

## Run it against the real core

Install the core with `src/build.ps1`, then just `npm start`. Defaults
already match the handoff contract:

| | path |
|---|---|
| settings folder | `%PROGRAMDATA%\Tracey\` |
| core binary | `%ProgramFiles%\Tracey\tracey.exe` |

Override either with `TRACEY_DIR` and `TRACEY_EXE`.

If Smart App Control blocks `tracey.exe`, turn it off: Windows Security → App &
browser control → Smart App Control → Off. It's a one-way change.

## The contract, as implemented

The UI **writes** `config.cfg`:

```
enabled=1
fmin=0.400
beta=0.0200
```

Written to a temp file and renamed, so the core polling at ~5 Hz can never read
a half-written file. Values are clamped to `fmin` 0.15–1.0 and `beta` 0.007–0.08
before they're written.

The UI **reads** `status.cfg` for `running`, `enabled`, `fmin`, `beta`, `preset`,
`tremor_hz`. `preset=0` means custom. Parsing tolerates comments, blank lines,
stray whitespace, and uppercase keys.

Calibration launches the core with `--calibrate` (via `Start-Process`, because a
uiAccess binary can't be started directly), waits for `running` to return to 0,
then reads `tremor_hz`.

## Stopping vs pausing

`enabled=0` pauses the core but leaves it running. `quit=1` stops it: the
process exits. Because a stale `quit=1` would make the next launched core exit
immediately, every ordinary write from the UI omits the key, which clears it.
The Advanced panel has both Stop and Start; the tray menu has Stop.

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
  mock-core.js    stand-in for tracey.exe
  make_icons.py   regenerates tray icons (npm run icons)
```

`core-comms.js` is the whole per-OS surface. When the macOS and Linux control
channels land, `defaultDir()` and `launchCore()` are the only functions that
change.

## Accessibility

This is assistive tech, so the UI is built for hands that shake: every target is
at least 44px, both sliders have large `−`/`+` steppers so nobody has to land a
drag precisely, three presets cover the common cases with one click, contrast
runs above 6:1 throughout, the whole app is keyboard-navigable with visible
focus, status changes announce through `aria-live`, and animation drops out
under `prefers-reduced-motion`.

## Demo notes

The drawing pad shows raw input in amber under filtered output in teal: the
before/after the pitch is built on, live and interactive. **Simulate a tremor**
injects synthetic shake so the difference is visible even with a steady hand;
turn it off when demoing with a real user.

The percentage under the pad is path-length reduction in this preview window
only. Do not quote it as a result: the real number is in `VALIDATION.md`
(~10% stroke jitter removed, 61 patients and 20 controls).
