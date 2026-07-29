# Tracey v3 - adaptive / ML layer

v3 augments the one-euro filter (it does not replace it). The roadmap has four pieces;
they split cleanly into "signal processing we can build and validate here" and "machine
learning that needs real tremor data".

## Status

| Piece | Type | Status |
|-------|------|--------|
| Tremor **frequency tracker** | DSP | **DONE + validated** ([common/tremor_tracker.h](common/tremor_tracker.h)) |
| Adaptive tremor **notch** | DSP | **DONE + integrated**, opt-in `--notch` ([common/notch.h](common/notch.h)) |
| **Online** cutoff adaptation | DSP | Ready (`tt_adaptive_fmin`); superseded by the notch as the better DSP path |
| Intention-vs-tremor **classifier** | ML | **Parked - data shows general case is ill-posed (needs a shape prior)** |
| Per-user tremor-**type profile** | ML | **Parked - needs more data** |

## Findings from real Parkinson's data

Isenkul/Sakar spiral dataset (Wacom tablet, pen X/Y @ ~111-143 Hz; tests SST/DST/STCP). Data is
gitignored (`v3/data/`) but the analysis is reproducible - run `python v3/analyze_spirals.py`.
The "Improved Spiral Test" folder is **~100% a duplicate** of the Isenkul set (verified by content
hash); after dedup the unique Static-Spiral corpus is **61 PD + 20 control** drawings.

Fitting each drawing's intended Archimedean spiral (`r = a + b*theta`) and measuring the radial
miss-from-intent:

| Static-Spiral metric | control (n=20) | Parkinson (n=61) |
|---|---|---|
| mean deviation from intended spiral | 3.2 px | **9.5 px (~3x)** |
| deviation energy in **un-filterable** <2 Hz wander | 86.7% | **95.2%** |
| one-euro (preset 3) jitter (path-length) reduction | 12.0% | 9.9% |

- **The accuracy gap is not filterable.** 92% of a PD spiral's deviation from the intended shape
  lives below 2 Hz - slow wander that overlaps intended motion. No causal filter (low-pass, notch,
  Kalman, anything) can separate it from intent without a shape prior. This is *why* every filter
  scores ~0% on deviation while still removing ~10% of jitter.
- **Jitter vs deviation are different signals:** the fast tremor rides in the local wiggle (jitter,
  ~10% removable) but contributes almost nothing to large-scale deviation. Smoothing helps
  smoothness, not accuracy.

**Conclusion (data-backed):** "straighten the line" is provably beyond any real-time filter. Worse,
for *general* drawing it is fundamentally ambiguous - a slow intended curve and a slow unintended
drift are identical in the signal, so you can only straighten when you already know the intended
shape (a template/app context). A real-time general intent model is a research project, not a
hackathon deliverable; the honest, defensible product claim is **"reduces tremor shake"** (removes
the jitter, validated above), **not** "straightens intent". See the parked-work section below.

## What's built: the tremor frequency tracker

`tremor_tracker.h` (header-only C, no dependencies beyond libm):

1. Buffers a sliding window of recent pen positions (128 samples, ~0.85 s at 150 Hz).
2. High-passes at 2.5 Hz (`TT_HP_HZ`), then linear-detrends the window (removes slow
   intended motion) and applies a Hann window. The high-pass matters because detrending
   removes only a straight-line ramp, so a *curved* scribble leaves a 1-2 Hz residue whose
   mainlobe spills into the lowest in-band bin and is read as tremor.
3. Runs a small radix-2 FFT on both axes, sums the power spectra, and finds the dominant
   bin in the tremor band (3-15 Hz), with parabolic interpolation for sub-bin accuracy.
4. Gates on peak strength so a steady hand reports **freq = 0** (no false tremor).
5. `tt_adaptive_fmin()` maps the measured frequency to a one-euro `fmin` (a 1st-order
   low-pass attenuates f by ~fc/f, so `fc = 0.25 * f_tremor` targets ~-12 dB at the tremor).

### Validated with synthetic signals (no tablet / no tremor user needed)

```
> test_tracker.exe
5 Hz tremor    -> freq=4.87 Hz strength=0.60  [PASS]
6 Hz tremor    -> freq=5.93 Hz strength=0.65  [PASS]
9 Hz tremor    -> freq=9.12 Hz strength=0.58  [PASS]
no tremor      -> freq=0.00 Hz strength=0.00  [PASS]
```

Build/run: `cl /nologo /O2 test_tracker.c /Fe:test_tracker.exe` (or `cc -O2 ...`), then run.

## How to wire it into the filter (online adaptation)

In a filter loop (e.g. v1/tracey.c's `on_pen`), per sample:

```c
tt_push(&tracker, rawx, rawy, t);
if ((sample_count++ % 16) == 0) {           /* re-analyze a few times/sec */
    tt_analyze(&tracker);
    double fmin = tt_adaptive_fmin(&tracker, baseline_fmin);  /* baseline = calibrated */
    g_fx.fmin = g_fy.fmin = fmin;            /* retune the one-euro filters */
}
```

On a steady hand this is identical to the calibrated baseline (tracker returns baseline);
with real tremor it lowers the cutoff to target the measured frequency. NOTE: the *benefit*
is only observable with an actual tremor - the DSP is validated, but "does it help a real
user" needs a tremor user to confirm, same as the calibration thresholds.

## What's built: the adaptive tremor notch (`--notch`)

`common/notch.h` (header-only RBJ biquad band-stop) removes the **specific** tremor frequency at
*any* stroke speed, while leaving slow intended motion and fine detail intact. The one-euro's
weakness is that its cutoff **rises with stroke speed**, so it passes tremor during fast strokes -
which is why it only removes ~10% of real jitter. Pipeline: `raw -> notch -> one-euro -> inject`,
per-stroke state reset, default path untouched (runs only under `--notch`).

**Where the center frequency comes from, and the catch.** The tracker's strength gate normalizes
the tremor peak by *total* spectral power. During real drawing the large intended motion swamps
that total, so the live tracker reports `freq=0` mid-stroke (proven in Scenario B below) - it can
**not** reliably find the tremor while you draw. Reliable detection only happens in the controlled
`--calibrate` scribble (little intended motion). So the notch is **seeded from calibration**: the
frequency `--calibrate` measures is persisted (`tremor_hz` in `profile.cfg`) and drives the notch;
the live tracker only *refines* it on the rare window a peak stands out. No calibration + no live
peak → the notch stays dormant (and logs "run --calibrate first"). This makes calibration actually
*do* something beyond the wizard's readout.

### Validated with synthetic signals (`test_notch.c`)

Two deliberately different regimes - the best case and the honest one:

```
> test_notch.exe
=== Scenario A: clean separable (0.5 Hz intent + 5 Hz tremor) ===
                        tremor@5Hz kept    intent@0.5Hz kept
one-euro (preset 3)         88.1%              99.4%
adaptive notch              24.4%             100.1%

=== Scenario B: realistic PD-like (0.4 Hz draw + 1.5 Hz drift + 3.8 Hz tremor) ===
                    jitter removed   deviation from intended path
one-euro (preset 3)       0.1%              11.93 px   (raw 11.14)
--notch (notch+1e)        4.9%              12.09 px
```

- **Scenario A (rhythmic tremor):** the notch removes **~75% of the tremor** vs the one-euro's ~12%,
  intent preserved ~100%. This is the visible-shake win.
- **Scenario B (realistic PD drawing):** with the tremor a *small* component riding on a dominant,
  un-notchable ~1.5 Hz drift, the notch removes **~5% of path-length jitter** (the real-data metric)
  vs the one-euro's ~0%, and **neither improves accuracy** (deviation from the true stroke). This is
  the honest number: the big win only materializes when the tremor is *rhythmic and a large share of
  the motion*.

Build/run: `cl /nologo /O2 /I . test_notch.c /Fe:test_notch.exe` then run.

**Honest scope:** the notch attacks the *rhythmic, narrow-band* tremor (the visible shake). The
dominant low-frequency PD drift that overlaps intended motion (see findings above) is un-notchable -
notching it would delete real strokes; that gap still needs the classifier. `--notch` is
experimental: the DSP is validated on synthetic signals, but the notch Q and the calibration
thresholds need tuning on real tremor hardware before it could become the default.

## What's parked, and why

The **intention-vs-tremor classifier** (turn a shaky intended-straight line straight) is parked
**not for lack of data - we now have it - but because the data shows the general version is
ill-posed.** Per the findings above, 92% of the PD accuracy gap is slow (<2 Hz) wander that is
*indistinguishable from intended slow motion in the signal alone*. On a Static Spiral we can cheat:
the intended shape is known, so we could snap toward the fitted spiral. But in a general drawing app
we don't know the target shape, and a slow intended curve looks exactly like a slow unintended
drift - so there is nothing to key on. Straightening is only well-posed when a **shape prior**
exists:

- **Feasible, template-based:** a "shape assist" mode that snaps to a line/arc/circle when the user
  is clearly drawing one (like PowerPoint's shape recognition), or straightening inside an app that
  knows its target (tracing, forms, CAD). This is a real, demoable feature - but it's an app/gesture
  layer, a different surface from the input filter, and it is honest about needing the prior.
- **Research-grade, template-free:** learn a per-user motion prior (bounded curvature-rate, velocity
  smoothness, tremor freq/amplitude) to bias the estimate toward "intended", trained on labeled
  tremor-user strokes. Genuine ML research, well past a hackathon window, and even then bounded by
  the ambiguity above.
- Tremor-type profile: extend the calibration wizard to classify resting / action / intention
  tremor and store per-type parameters (the notch already leans on the calibrated frequency).

Bottom line for the product: claim **"reduces tremor shake"** (true, validated), not "straightens
intent". The reproducible analysis lives in `v3/analyze_spirals.py`.
