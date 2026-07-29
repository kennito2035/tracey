# Tracey: real-time tremor compensation for pen input

**Tracey makes drawing and handwriting usable again for people with hand tremor, in the
apps they already use.**

For someone with Parkinson's disease or essential tremor, a digital pen is often unusable:
every line comes out shaky. Tracey runs quietly in the background, smooths the pen's tremor
in real time, and feeds the cleaned-up input to **whatever app is already open** (Paint,
OneNote, Photoshop, a signature box on a web form). Nothing to relearn, no app to replace.

---

## Who it's for & the problem
Hand tremor (11.8M with Parkinson's worldwide in 2021, projected to reach 25.2M by 2050;
essential tremor is more common still, at ~7M in the US alone) turns
intended pen strokes into jagged, illegible marks, quietly locking people out of signing
forms, sketching, handwritten notes, and creative software. Tracey is for **anyone whose
hand shakes when they use a pen** and who wants to keep working independently.

## What it does
- **Smooths pen input in real time**, system-wide: tremor becomes visibly steadier.
- **Works in every pen/ink app**: it filters input *before* the app sees it.
- **Calibrates to the individual**: a 10-second scribble measures how much your hand actually
  moves and auto-tunes; live presets (light → heavy) dial it in.
- **Stays out of the way**: background service; mouse and keyboard untouched, only the pen.

## How it works
1. **Intercept** the pen (Windows pointer APIs + a signed **uiAccess** process to capture
   input system-wide).
2. **Filter** the X/Y path with the **one-euro filter** (Casiez et al., 2012), an adaptive
   low-pass that removes tremor jitter while staying responsive to fast, intentional motion.
   Pressure/tilt pass through untouched.
3. **Re-inject** the smoothed stroke so the app underneath receives a clean line. An FFT
   **tremor-frequency tracker** also runs during calibration, but it is *not* in the default
   filter path and has no user-facing readout: on real patient data it does not reliably
   identify a tremor frequency. It seeds the experimental `--notch` mode only (see VALIDATION.md).

## Evidence: validated on real patients
- **Real hardware** (XP-Pen tablet): the full capture → filter → re-inject pipeline works
  end-to-end in real apps, verified in **Microsoft Paint and Adobe Photoshop**. Photoshop is
  the case that matters most: it takes the pen through Windows Ink like everything else, so
  it needs nothing special from us.
- **61 Parkinson's patients + 15 controls** (public spiral-drawing dataset, pen X/Y at either 111
  or 143 Hz depending on the recording; the archive's duplicate folder excluded, not merely
  hashed): Parkinson's tremor is **~3.5× a steady hand's** deviation, and Tracey removes
  **~10% of stroke jitter**, the visible shake. We also measured, honestly, what it *can't* do:
  it does **not** correct large-scale drift (92% of it is <2 Hz and overlaps intended motion:
  an intent model, not a filter; see Roadmap). **→ [VALIDATION.md](VALIDATION.md)** for the
  before/after figure, the numbers, and how to reproduce them.

## Platform support
**Tracey is a Windows 10/11 application.** The native core, the control channel and the UI
all run there, and that is the whole of what this repository ships.

The UI is built on a cross-platform stack and its core-communication layer is a thin per-OS
adapter, so other platforms could be added later without rewriting the interface. No macOS
or Linux build is claimed or shipped here.

## Install (Windows 10 1809+ or Windows 11, pen tablet with Windows Ink enabled)

Download **`Tracey-Setup-*.exe`** from [Releases](../../releases) and run it.

The installer asks for administrator rights, and it tells you why before it writes anything.
Windows only grants the pen-capture permission (**uiAccess**) to a *signed* program running
from a *protected* folder, so Tracey installs to `C:\Program Files\Tracey` (not adjustable,
for that reason) and adds its signing certificate to the machine's Trusted Root store. A
consent page explains this in plain language first, and **uninstalling removes the
certificate again**. Uninstalling also asks whether to keep your settings and calibration.

SmartScreen will say the publisher is unknown, because the installer is not commercially signed.
Choose **More info → Run anyway**.

Then open Tracey, turn it on, and draw in any app. `Ctrl+Alt+1..5` sets smoothing strength
and `Ctrl+Alt+Q` quits, from anywhere.

If the core will not start, Windows 11's **Smart App Control** may be blocking it (the build
is self-signed). Turn it off under Windows Security → App & browser control → Smart App
Control. This is a one-way change.

### Or build it yourself
```powershell
# The native core (ELEVATED to install; -NoInstall works from a normal shell)
cd src
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\build.ps1                # compile -> icon/version resources -> sign -> install
.\build.ps1 -NoInstall     # ...or stop before the %ProgramFiles% copy

# The UI and the installer
cd ..\ui
npm install
npm run dist               # -> ui\dist\Tracey-Setup-<version>.exe
```
`build.ps1` creates and trusts a self-signed development certificate on first run. Do not
pipe it through `2>&1`: `vcvars64.bat` writes a harmless line to stderr that PowerShell then
promotes to a fatal error.

## Repository structure
```
README.md            this file
VALIDATION.md        real-patient validation: before/after figure + GIF, numbers, reproducibility
validation_spiral.png  static hero (real PD spiral: raw vs Tracey, overlaid + zoom)
validation_demo.gif    animated before/after (raw shaky pen vs Tracey, drawn in sync)
ui/                  the cross-platform UI (Electron): tray, settings, calibration wizard
  electron/            main process + core-comms.js (the ONLY place that talks to the core)
  renderer/            settings window, calibration wizard, live preview
  tools/               mock-core.js (run the UI with no real core), verify.js (contract suite),
                       audit.js (cross-layer consistency), prepare-core.js (stages the core)
  build/               INSTALLER config, not build output: installer.nsh (certificate import,
                       ProgramData permissions, shortcut page) + CERTIFICATE_NOTICE.txt (consent)
src/                 the native-C core
  tracey.c             core: capture -> one-euro filter -> re-inject; calibration; --notch; UI channel
  common/oneeuro.h        one-euro filter (header-only)
  common/tremor_tracker.h FFT tremor-frequency tracker
  common/notch.h          adaptive tremor notch (opt-in --notch)
  build.ps1            compile (MSVC) -> sign -> install to C:\Program Files\Tracey
  test_tracker.c       unit test for the tremor tracker
  test_notch.c         notch vs one-euro comparison (synthetic, two regimes)
  analyze_spirals.py, make_validation_figure.py, make_validation_gif.py   real-data analysis (reproduces VALIDATION.md)
packaging/           uiaccess_manifest.xml (requireAdministrator + uiAccess),
                     tracey.rc + tracey.ico (the core's icon and version strings: what the
                     UAC prompt shows, so not cosmetic)
LICENSE              MIT
```

## Roadmap
- **Cross-platform:** macOS (CGEventTap) and Linux (evdev/uinput) support; touch input.
- **Intention model:** use the *intended* shape to correct tremor drift, the piece that could
  turn a shaky line straight. Our patient-data analysis shows this is ill-posed for freeform
  drawing without a shape prior (see [VALIDATION.md](VALIDATION.md)): a research direction, not
  just a filter tweak.
- **Distribution:** a reputable code-signing cert so it runs without disabling Smart App Control.

## Credits
Built for the Assistive Innovation Challenge 2026. One-euro filter: Casiez, Roussel & Vogel
(2012). Validation used public Parkinson's spiral-drawing datasets (Isenkul, Sakar et al.), for measurement only; no dataset is redistributed here.
