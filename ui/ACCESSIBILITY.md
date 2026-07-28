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
- Sliders are never the only way to set a value. Each has **48 px `−` / `+`
  steppers**, so nobody has to land a precise drag. Three named presets cover
  the common cases in a single tap.
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

| Element | Ratio | |
|---|---|---|
| Body text `#17222E` on `#FFFFFF` | **16.1:1** | AAA |
| Secondary text `#44566A` | **7.5:1** | AAA |
| Teal small text `#0A6B60` | **6.4:1** | AAA |
| White on teal button `#0B7F72` | **4.9:1** | AA |
| Amber text `#A05E1C` | **5.1:1** | AA |
| Dark theme body `#EAF1F7` on `#1B2733` | **13.3:1** | AAA |
| Dark theme secondary `#9BAFC2` | **6.7:1** | AAA |

One bug this caught: filled teal buttons were originally `#0F9E8E`, which is
**3.3:1** against white, below AA. Darkened to `#0B7F72`.

## Light by default, dark by choice

Large fields of bright text on near-black halate for people with astigmatism,
which is common in the age group most affected by essential tremor. So the
default is light. But some low-vision users genuinely need dark, so it is a
toggle rather than a decision made for them. First launch follows the operating
system setting.

## Colour carries meaning, and the meaning matters

**Teal** owns everything steady: the switch when on, confirmations, progress.
It reads as calm and medical-trustworthy without being clinical.

**The tremor is amber, never red.** Red means error. A person's own hand must
never be presented to them as an error. Amber is warm, human, and simply
different from teal, which is all the contrast the practice pad needs.

Colour is never the only signal. State is also carried by the switch position,
the wave flattening, the headline text, and the tray icon shape.

## Language

No jargon reaches the user. "Your pen is steady", not "filtering active". "Set
up for my hand", not "calibrate". Presets are Gentle, Balanced and Steadiest,
with no numbers attached. The words `core`, `fmin`, `beta` and `Hz` appear only
inside Advanced, except the one Hz reading after calibration, which is the
moment the app tells you something true about your own body.

## Keyboard, screen reader, motion

- Full keyboard navigation with a visible 3 px focus ring at 3 px offset.
- The switch is a real `role="switch"` with `aria-checked`; presets are
  `aria-pressed`; the progress bar reports `aria-valuenow`.
- Status changes announce through `aria-live="polite"` regions.
- Dialogs use the native `<dialog>` element, so focus trapping and Escape are
  handled by the browser rather than by hand-written script.
- **Every animation is disabled under `prefers-reduced-motion`**, including the
  ripples, the switch spring and the breathing glow. Vestibular sensitivity and
  tremor co-occur often enough that this is not optional.

## What we did not do

No sound cues: untested with this population and easy to get wrong. No voice
control: out of scope for a weekend build. No high-contrast Windows theme
integration; the manual toggle covers most of the need but proper
`forced-colors` support is the honest next step.
