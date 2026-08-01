<p align="center">
  <img src="ui/assets/icon.png" width="140" alt="Tracey, a steadied pen stroke on a rounded teal tile">
</p>

# Tracey
### Real-time tremor compensation for pen input on Windows: filter the shake before any app sees it

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Hackathon](https://img.shields.io/badge/Assistive%20Innovation-Challenge%202026-orange.svg)]()
[![Download](https://img.shields.io/badge/Download-Tracey--Setup--0.1.0.exe-blue.svg)](https://github.com/kennito2035/tracey/releases/latest)

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
  moves and interpolates between the presets; **Gentle**, **Balanced** and **Steadiest** dial it
  in by hand.
- **Stays out of the way**: runs in the background; mouse and keyboard untouched, only the pen.

## How it works
1. **Intercept** the pen (Windows pointer APIs + a signed **uiAccess** process to capture
   input system-wide).
2. **Filter** the X/Y path with the **one-euro filter** (Casiez et al., 2012), an adaptive
   low-pass that removes tremor jitter while staying responsive to fast, intentional motion.
   Pressure and tilt pass through unfiltered: only X/Y are smoothed, so tilt-aware
   brushes keep the angle the tablet reported. Tilt is forwarded only when the pen
   actually reports it, never invented.
3. **Re-inject** the smoothed stroke so the app underneath receives a clean line. An FFT
   **tremor-frequency tracker** also runs during calibration, but it is *not* in the default
   filter path and has no user-facing readout: on real patient data it does not reliably
   identify a tremor frequency. It seeds the experimental `--notch` mode only (see VALIDATION.md).

## Evidence: validated on real patients
- **Real hardware** (XP-Pen tablet): the full capture → filter → re-inject pipeline works
  end-to-end in real apps, verified in **Microsoft Paint and Adobe Photoshop**. Photoshop is
  the case that matters most: it takes the pen through Windows Ink like everything else, so
  it needs nothing special from us.
- **61 Parkinson's patients + 15 controls** ([UCI Parkinson disease spiral drawings](https://archive.ics.uci.edu/dataset/395/parkinson+disease+spiral+drawings+using+digitized+graphics+tablet), pen X/Y at either 111
  or 143 Hz depending on the recording; the Static-Spiral segments of the archive's
  `hw_dataset` and `new_dataset`): Parkinson's tremor is **~3.5× a steady hand's** deviation, and Tracey removes
  **~19% of the 4–8 Hz band** a neurologist would name, the clinical tremor range, at the
  Steadiest preset. We also measured, honestly, what it *can't* do:
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

Then open Tracey, turn it on, and draw in any app. `Ctrl+Alt+1`, `Ctrl+Alt+2` and
`Ctrl+Alt+3` select Gentle, Balanced and Steadiest, the same three cards the window shows,
and `Ctrl+Alt+Q` stops the filter. All from anywhere.

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
  README.md            what the v3 DSP layer is, what is built and what is parked
  test_tracker.c       unit test for the tremor tracker
  test_notch.c         notch vs one-euro comparison (synthetic, two regimes)
  test_latency.c       the added-latency table in VALIDATION.md
  test_tilt.c          pen tilt forwarding, against the real inject() (stubs the
                       injection call, so it needs no tablet)
  analyze_spirals.py, analyze_tremor_detect.py, make_validation_figure.py,
  make_validation_gif.py   real-data analysis (reproduces VALIDATION.md)
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
(2012). Validation used the [UCI Parkinson disease spiral drawings dataset](https://archive.ics.uci.edu/dataset/395/parkinson+disease+spiral+drawings+using+digitized+graphics+tablet)
(Isenkul, Sakar & Sakar, 2014), for measurement only; no dataset is redistributed here.
