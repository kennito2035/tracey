# Accessibility decisions

Tracey is used by people with Parkinson's disease and essential tremor. The
interface is part of the assistive claim, not decoration around it. Every
decision below has a reason and, where it can be measured, a number.

---

## The governing idea

An early version of this UI was a dark instrument panel: dense, four sections,
monospace readouts, `fmin` and `beta` on screen. It served the developers. A
68-year-old opening it would have seen machinery.

The rebuild follows one rule: **one thing per screen, and the one thing is
large.** Everything technical still exists, behind a disclosure. Nothing was
removed; it was ranked.

## Targets sized for hands that shake

- Main switch: **208 × 96 px**. It is the most-used control and it is the
  largest thing in the app.
- Every button, stepper and card: **≥ 44 px**, the WCAG 2.5.5 target size.
- Sliders are never the only way to set a value. Each has **50 px `−` / `+`
  steppers**, so nobody has to land a precise drag. Three named presets cover
  the common cases in a single tap, with Custom re-applying a calibration.
- Cards are large tap areas rather than small text links.

## Every tap is acknowledged

A person whose hand shakes cannot always tell whether a tap registered, so they
tap again. The UI answers every touch within ~100 ms: a ripple blooms from the
contact point, buttons seat down under pressure, the chosen preset springs a
checkmark, the switch overshoots and settles. This is failure prevention wearing
the clothes of polish.

## Contrast, measured

Computed with the WCAG 2.1 relative-luminance formula. AA needs 4.5:1 for body
text, 3:1 for large text and UI components.

Against `--surface`, the card colour most text actually sits on.

| Element | Ratio | |
|---|---|---|
| Body text `#23211D` on `#EFEDE7` | **13.7:1** | AAA |
| Secondary text `#54504A` | **6.8:1** | AA |
| Teal small text `#0A6B60` | **5.5:1** | AA |
| White on teal button `#0B7F72` | **4.9:1** | AA |
| Amber text `#8F5417` | **5.2:1** | AA |
| Dark theme body `#EAF1F7` on `#1B2733` | **13.3:1** | AAA |
| Dark theme secondary `#9BAFC2` | **6.7:1** | AA |

One bug this caught: filled teal buttons were originally `#0F9E8E`, which is
**3.3:1** against white, below AA. Darkened to `#0B7F72`.

**Recomputed against the shipped tokens on 2026-07-30, and three rows moved.** The
table had been quoting a retired palette: `#17222E` on `#FFFFFF` and `#44566A` are
in no stylesheet in this repo, and `#A05E1C` survives only in a comment recording
that it was replaced when the surfaces went warmer. The light theme is not paper
white, so measuring against `#FFFFFF` flattered every light-theme row. Two rows
labelled AAA are AA once measured against the colour they are really drawn on:
AAA wants 7:1 for body text and these land at 6.8 and 5.5. Everything still clears
AA. Claiming a level the palette does not reach is the kind of error an
accessibility document least affords.

## The system's choice by default, either by preference

Large fields of bright text on near-black halate for people with astigmatism,
which is common in the age group most affected by essential tremor. But some
low-vision users genuinely need dark, so this is a toggle rather than a decision
made for them. **First launch follows the operating system setting**, falling
back to light where the system expresses no preference; the toggle then wins
and persists.

That is what this section always claimed. It was not what the code did: the
renderer defaulted to dark unconditionally, on the grounds that the window sits
beside a drawing canvas and a bright panel next to artwork is distracting. That
is a taste argument overriding an accessibility one, and it was also overriding a
choice the user had already made once, at the operating system. Corrected
2026-07-30, in the code rather than in the claim.

## Colour carries meaning, and the meaning matters

**Teal** owns everything steady: the switch when on, confirmations, progress.
It reads as calm and medical-trustworthy without being clinical.

**The tremor is amber, never red.** Red means error. A person's own hand must
never be presented to them as an error. Amber is warm, human, and simply
different from teal, which is all the contrast the practice pad needs.

Colour is never the only signal. State is also carried by the switch position,
the wave flattening, the headline text, and the tray icon shape: steadying is a
wave, paused is two upright bars, stopped is one flat line. Those three glyphs
differ as *shapes*, so the tile colour is decoration rather than the message.
They used to be the same wave in three colours, which meant a colour-blind user
had nothing to read at all: verified now by comparing colour-independent ink
masks, where every pair differs by 8 percent of the tile or more at every size,
against exactly 0 for the old active-versus-paused pair.

## Language

No jargon reaches the user. "Your pen is steady", not "filtering active". "Set
up for my hand", not "calibrate". Presets are Gentle, Balanced and Steadiest,
with no numbers attached. The words `core`, `fmin` and `beta` appear only inside
Advanced. `Hz` appears nowhere in the interface at all: the calibration wizard
ends on "Smoothing is now tuned to your hand", never on a frequency. A version
that showed one was built and then removed. Ranking two groups by tremor
strength is a different claim from handing one person their own number, and on
the live calibration task the detector still reports a tremor for 3 of 20
steady hands at a clinical-sounding 5.2 Hz. Telling someone they have a tremor
they do not have is an accessibility failure, not a feature.

## Keyboard, screen reader, motion

- Full keyboard navigation with a visible 3 px focus ring at 3 px offset.
- The switch is a real `role="switch"` with `aria-checked`; presets are
  `aria-pressed`; the progress bar reports `aria-valuenow`.
- Status changes announce through `aria-live="polite"` regions.
- Dialogs use the native `<dialog>` element, so focus trapping and Escape are
  handled by the browser rather than by hand-written script.
- **Every animation is disabled under `prefers-reduced-motion`**, including the
  ripples, the switch spring, the breathing glow, and the ones declared on
  pseudo-elements: the selected-preset checkmark's overshooting bounce, the knob
  wave crossfades and the Advanced chevron. That last group is easy to miss,
  because the obvious `* { animation: none }` does not match `::before` or
  `::after` and leaves exactly the overshoot this rule exists to suppress still
  playing. `npm run check-motion` proves it in the app's own Electron by reading
  computed styles with reduced motion emulated. Vestibular sensitivity and tremor
  co-occur often enough that this is not optional.

## What we did not do

No sound cues: untested with this population and easy to get wrong. No voice
control: out of scope for a weekend build. No high-contrast Windows theme
integration; the manual toggle covers most of the need but proper
`forced-colors` support is the honest next step.
