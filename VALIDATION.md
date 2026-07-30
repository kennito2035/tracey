# Tracey: validated on real Parkinson's data

**Most hackathon assistive-tech is demoed on a healthy hand. Tracey is validated on 61 real
Parkinson's patients** (plus 15 controls) from a published clinical spiral-drawing dataset.

![Animated: raw shaky pen vs Tracey, drawn in sync](validation_demo.gif)

*The same real Parkinson's stroke drawn twice, in sync: the raw pen tip (left) shakes; Tracey's
(right) glides. This is the live experience: Tracey sits between the pen and the app.*

For a closer look at exactly what gets removed:

![Tracey on real Parkinson's spiral drawings](validation_spiral.png)

*A real Parkinson's patient's Static Spiral Test. **Red** = the raw shaky pen path; **blue** = the
same stroke after Tracey. Left: the whole spiral, where Tracey's line runs smoother than the raw tremor
on every arm. Right: a zoom into the boxed segment, where the tremor zigzag and Tracey's smoothing
are unmistakable. Tracey reduces the shake's amplitude; the large-scale spiral is the person's own
intended path, preserved (not straightened).*

## The data
The [Isenkul/Sakar Parkinson spiral dataset](https://archive.ics.uci.edu/dataset/395/parkinson+disease+spiral+drawings+using+digitized+graphics+tablet)
(digitizing tablet; pen X/Y sampled at either **111 Hz or 143 Hz** depending on the recording:
26 of the 76 drawings use the slower clock and 50 the faster, with nothing in between). Patients
trace a printed Archimedean spiral, a
standard clinical test for hand tremor. The download ships an "Improved Spiral Test" folder that is
a second copy of the base set, so we exclude it, and hashing alone is not enough to catch it, since
five of its "Healthy" files are the same five control subjects' same drawings with a few extra
trailing samples. Excluding it leaves a **unique corpus of 61 PD + 15 control** Static-Spiral
drawings, matching the dataset's own description of 62 Parkinson's and 15 healthy participants (one
PD file has an empty Static-Spiral segment).

## What Tracey does, measured
Fitting each drawing's *intended* spiral and comparing raw vs. filtered pen paths:

All figures below are at the UI's **Steadiest** preset (`fmin 0.22, beta 0.010`), the same setting
the figure and the GIF are rendered with, so what you see is what the numbers describe.

| metric | control (n=15) | Parkinson's (n=61) |
|---|---|---|
| tremor size (deviation from the intended spiral) | 2.7 px | **9.5 px (≈3.5× more)** |
| **4–8 Hz tremor band removed** (clinical PD + essential band) | 18.3% | **19.0%** |
| excess pen travel removed (wiggle above the intended shape) | 90.4% | **63.7%** |
| >15 Hz removed (digitizer noise, *not* visible shake) | 33.1% | 19.6% |
| intended motion (<2 Hz) changed | −3.9% | **−0.6%** |
| total path length removed (incl. the spiral itself) | 12.9% | 10.0% |

*Both cells of the 4–8 Hz row are the same statistic: each drawing's own reduction, averaged over
the group, so the two columns are comparable and every drawing counts equally. The other rows are
group aggregates. `analyze_spirals.py` prints both statistics for both groups at every preset,
because these two got mixed once: a control figure computed one way (16.3%) sat beside a patient
figure computed the other (19.0%), which is not a comparison. Under the aggregate statistic the
same pair reads 16.3% and 20.7%.*

Tracey removes **19% of the tremor band a neurologist would name** (the 4–8 Hz range covering
Parkinson's rest tremor and essential tremor) while changing the person's *intended* motion by
**under 1%**. That second number is the one we are proudest of: many smoothers buy their smoothness
by eating the stroke.

**Note what the control column does and does not say.** Tracey removes a similar *proportion* of the
4–8 Hz band from a steady hand as from a patient, 18.3% against 19.0%, and it should: it is a
filter, not a classifier,
and it has no idea who is holding the pen. It *does* adapt, but only to pen **speed**: the one-euro
cutoff is `fmin + beta * |velocity|`, recomputed on every sample from a smoothed estimate of the
pen's own velocity (`src/common/oneeuro.h`). That makes it nonlinear and time-varying, and no more
selective for tremor: it carries no model of tremor, of intent, or of the person.
What differs is how much there is to remove.
A Parkinson's drawing deviates from the intended spiral by **3.5× as much**, so the same proportional
reduction is a far larger absolute improvement, and on a steady hand most of what comes out is
digitizer noise nobody could see anyway (note the 33% figure in the >15 Hz row). Any claim that a
filter like this "detects" tremor would be false, and we do not make one.

The 64% "excess pen travel" figure is real but must not be quoted alone: excess travel is dominated
by very-high-frequency jitter, a good part of which is tablet quantisation rather than the shake a
person sees. The 10% total-path figure is the same measurement flattered in the other direction:
most of a spiral's path length *is* the spiral. **The defensible headline is the 4–8 Hz number.**

Reduction scales with the preset, and so does lag (measured across all 61 patients):

| preset | 4–8 Hz removed | ink trails the pen by |
|---|---|---|
| Gentle (0.70 / 0.050) | 8.9% | 1.76 px |
| Balanced (0.40 / 0.020) | 14.1% | 2.92 px |
| **Steadiest (0.22 / 0.010)** | **19.0%** | **4.25 px** |
| heavier (0.10 / 0.002), not shipped | 30.8% | 9.59 px |

Reduction keeps climbing past the shipped presets, but the lag climbs faster and it is lag the user
feels: `0.07/0.001` reaches 35.4% only by letting the ink trail the pen by **13.5 px**, which is
visible drag. There is no hidden setting that buys a large reduction cheaply - that trade is a
property of a causal low-pass against a tremor overlapping intended motion, not a tuning oversight.

## Latency: what Tracey actually adds

"How much lag does it add?" has four parts, and only one of them is Tracey's doing.

| | |
|---|---|
| tablet -> Windows delivers the sample | not attributable to Tracey; the pen reports every **3.8 ms** (measured) |
| **filter group delay** | **the whole story, see below** |
| filter -> re-inject | **35 us** measured across every real session (`inject_avg`, 30-43 us) |
| app draws it -> screen | the app's own pipeline, identical with or without Tracey |

The filter's delay is **speed-dependent by construction**: the one-euro cutoff is
`fc = fmin + beta*|velocity|`, so the faster you move the less it lags. A single latency number
for a one-euro filter is therefore meaningless. Measured with the shipped `oneeuro.h` by driving
it with a constant-velocity ramp, where a first-order low-pass settles to a spatial error of
exactly `tau*v` (`src/test_latency.c`, milliseconds):

| pen speed -> | 50 px/s | 200 px/s | 600 px/s | 1500 px/s |
|---|---|---|---|---|
| Gentle | 13.3 | 6.0 | 2.9 | 1.5 |
| **Balanced** | **22.1** | **10.4** | **5.4** | **3.0** |
| Steadiest | 32.2 | 15.4 | 8.3 | 4.7 |

On a **real Parkinson's drawing** (2645 samples, 23.8 s, 111 Hz, mean pen speed 92 px/s) the ink
trails the pen by **2.34 px / 25.5 ms** at Balanced and **3.43 px / 37.4 ms** at Steadiest.

**So: roughly 10 ms at normal writing speed on the default setting, 25 ms on real patient data,
and 35 microseconds of that is Tracey's own processing.** The rest is the smoothing lag you are
deliberately buying steadiness with. Turn the preset down and it shrinks, exactly as the table
above shows. What cannot be measured in software is pen-to-photon: the display and the drawing
app contribute their own latency, and they do so whether Tracey is running or not.

## Honest scope: stated up front, because it's a strength
Tracey **reduces tremor amplitude; it does not rewrite intent.** In the figure the smoothed blue
spiral is calmer than the red, but it still wanders: it does not snap to the clean control shape.
That is deliberate and provable: we measured that **92% of a Parkinson's spiral's deviation from the
intended shape is slow (<2 Hz) drift that overlaps intended motion.** No real-time filter can
separate "slow drift I didn't mean" from "slow curve I did mean" without knowing the target shape in
advance, so Tracey honestly smooths the shake rather than faking a straightened line it can't
actually infer. Claiming otherwise would be a lie a clinician would catch in five seconds.

## The tremor-frequency detector, and why it shows you nothing

A sliding-FFT tracker estimates the dominant tremor frequency during calibration. It seeds the
experimental `--notch` mode. **It has no user-facing readout, and that is a deliberate decision
backed by these numbers rather than a missing feature.**

Scored on the same 61 patients and 15 controls, as a ranking of two groups:

| statistic | AUC | 95% CI (bootstrap, 20k resamples) |
|---|---|---|
| mean in-band peak strength | **0.754** | **[0.644, 0.856]** |
| strongest in-band peak strength | 0.690 | [0.566, 0.807] |

Both intervals clear 0.5, so the detector carries real information. Before we put a 2.5 Hz
high-pass ahead of the FFT it did not: AUC 0.395 and 0.358, with intervals of [0.254, 0.534] and
[0.214, 0.507] that straddle chance entirely. The high-pass is what moved it, and it ships.

**Above chance is still not good enough to show someone a number**, for two separate reasons.

An AUC ranks two *groups*. It says a randomly chosen patient tends to score above a randomly chosen
control. It does not say that any particular person's reading is their tremor frequency, and those
are different claims.

And on the task we actually ship, the calibration scribble at roughly 250 Hz rather than a spiral
at 111, we recorded 20 ten-second takes from a hand with no tremor. Every frequency reported there
is by definition a false positive. As shipped, the detector reports a tremor for **3 of those 20**,
at a confident-sounding 5.2 Hz. Before the high-pass it was 20 of 20 at about 4.0 Hz. A 15% chance
of telling a steady-handed person they have a clinical-band tremor is not a feature worth having,
so the number stays internal.

The blind spot is structural, not a threshold we failed to tune. At the window size that ships, the
frequency bins are 1.97 Hz apart and the lowest is discarded as drift, so the detector cannot name
any tremor between 3.5 and 5 Hz at any amplitude, which is most of the Parkinson's rest-tremor band.
Doubling the window resolves that band and takes the steady-hand false positives from 3-in-20 to
20-in-20. There is no setting that both sees the tremor and stays quiet on a hand that does not
have one.

## Reproduce it
Everything above regenerates from the raw data with the scripts in the repo (need `numpy` +
`matplotlib`; drop the [UCI dataset](https://archive.ics.uci.edu/dataset/395/parkinson+disease+spiral+drawings+using+digitized+graphics+tablet)
into `src/data/` first; it's redistributable but gitignored):
```
python src/analyze_spirals.py         # the numbers (dedup, deviation, filterability)
python src/analyze_tremor_detect.py   # the detector: AUCs and their bootstrap intervals
python src/make_validation_figure.py  # the static before/after + zoom
python src/make_validation_gif.py     # the animated before/after
```
The dataset itself is not committed; the analysis is (so these numbers can't quietly rot).
