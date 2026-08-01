#!/usr/bin/env python3
"""make_validation_gif2.py - animated before/after on a STRAIGHT stroke.

Companion to make_validation_gif.py, same two-panel style, same colours, same preset.
That one animates a real Parkinson's spiral; this one animates the other thing people
try first with a pen, a single straight line drawn slowly, which is where tremor is
most obvious to a viewer who has never seen a spiral test.

THE STROKE IS SYNTHETIC AND THE CAPTION SAYS SO. There is no straight-line task in the
Isenkul/Sakar set and no recorded patient straight line exists, so the intended path is
generated and the tremor is added on top. That is the same thing the app's practice pad
does behind "Pretend my hand shakes". It is an illustration of the filter's behaviour,
not a measurement, and it must never sit next to the 61-patient figures without the
provenance line. Keep the caption's first line honest if you change anything here.

IT IS NOT SUPPOSED TO COME OUT STRAIGHT. The filter reduces tremor; it does not infer
that the user meant a straight line, which would take the intention classifier this
product does not ship. If you find yourself raising the preset until the blue line looks
like a ruler, stop: that is the one claim the whole project refuses to make.

Writes an optimized looping GIF (Pillow, no ffmpeg).
"""
# The UI's "Steadiest" card, verbatim from ui/electron/core-comms.js PRESETS. Same value
# as make_validation_gif.py and make_validation_figure.py on purpose: one setting, in one
# place, and the one the demo video is filmed at.
STEADIEST = (0.22, 0.010)

import os, argparse
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_out():
    for c in (os.path.join(HERE, "..", "tracey-handoff"), os.path.join(HERE, "..")):
        if os.path.exists(os.path.join(c, "VALIDATION.md")):
            return c
    return HERE


OUT = os.path.join(_find_out(), "validation_demo2.gif")


def oneeuro(x, t_ms, fmin, beta, dcut=1.0):
    """Byte-for-byte the same filter as make_validation_gif.py, which is the same variant
    as analyze_spirals.py and the C core: the velocity estimate comes from the FILTERED
    previous value, not the raw previous sample the Casiez paper uses. Every published
    Tracey number was measured against this form. Do not make it canonical."""
    A = lambda c, dtp: 1.0 / (1.0 + (1.0 / (2 * np.pi * c)) / dtp)
    out = np.empty_like(x); xp = x[0]; dxp = 0.0; out[0] = x[0]
    for i in range(1, len(x)):
        dtp = (t_ms[i] - t_ms[i - 1]) / 1000.0
        if dtp <= 0: dtp = 1 / 143.0
        dx = (x[i] - xp) / dtp
        dxp += A(dcut, dtp) * (dx - dxp)
        xp += A(fmin + beta * abs(dxp), dtp) * (x[i] - xp)
        out[i] = xp
    return out


def band(d, fs, lo, hi):
    d = d - d.mean()
    p = np.abs(np.fft.rfft(d)) ** 2
    fr = np.fft.rfftfreq(len(d), 1.0 / fs)
    return p[(fr >= lo) & (fr < hi)].sum()


def make_line(seconds, fs, length, amp, hz, seed=7):
    """A straight horizontal stroke drawn at a steady pace, carrying tremor.

    The intended path is exactly straight, so every wobble on screen is tremor. Speed
    matters more than it looks: the one-euro's cutoff rises with velocity, so a fast
    stroke passes tremor straight through. Measured at amp=15, the same stroke gives
    3% removed at 250 px/s and 31% at 69 px/s. The default here is a slow, deliberate
    line, which is how someone with a tremor actually draws one.
    """
    rng = np.random.default_rng(seed)
    n = int(seconds * fs)
    t_ms = np.arange(n) / fs * 1000.0
    x = np.linspace(0.0, length, n)
    w = 2 * np.pi * hz * (t_ms / 1000.0)
    # Not a pure tone: a second partial plus a little drift, or the raw stroke reads as
    # a function plot rather than a hand.
    tremor = amp * np.sin(w) + 0.35 * amp * np.sin(2.13 * w + 0.7)
    drift = np.cumsum(rng.normal(0, 0.35, n))
    drift -= np.linspace(drift[0], drift[-1], n)
    y = tremor + drift
    x = x + 0.25 * amp * np.sin(1.7 * w + 1.1)
    return x, y, t_ms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--amp", type=float, default=15.0, help="tremor amplitude in px")
    ap.add_argument("--hz", type=float, default=5.5, help="tremor frequency")
    ap.add_argument("--seconds", type=float, default=5.5, help="how long the stroke takes")
    ap.add_argument("--length", type=float, default=380.0, help="stroke length in px")
    ap.add_argument("--fs", type=float, default=250.0, help="sample rate")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    px, py, pt = make_line(a.seconds, a.fs, a.length, a.amp, a.hz)
    fx = oneeuro(px, pt, *STEADIEST)
    fy = oneeuro(py, pt, *STEADIEST)
    n = len(px)

    raw_p = band(px, a.fs, 4, 8) + band(py, a.fs, 4, 8)
    fil_p = band(fx, a.fs, 4, 8) + band(fy, a.fs, 4, 8)
    removed = (1.0 - fil_p / raw_p) * 100.0 if raw_p > 0 else 0.0
    dev = float(np.mean(np.hypot(px - fx, py - fy)))

    # Style is make_validation_gif.py's, deliberately: same two colours, same weights,
    # same tip markers, same caption treatment. The figure is shorter because a straight
    # stroke is far wider than it is tall and equal aspect would otherwise leave the top
    # and bottom thirds of the frame empty.
    RAW, TRC = "#e53935", "#1565c0"
    fig, (axR, axT) = plt.subplots(1, 2, figsize=(9.2, 3.1))
    fig.patch.set_facecolor("white")
    xs = np.concatenate([px, fx]); ys = np.concatenate([py, fy])
    mx = 0.06 * (xs.max() - xs.min())
    my = 0.55 * (ys.max() - ys.min())      # generous: the stroke is a thin flat band
    xlim = (xs.min() - mx, xs.max() + mx)
    ylim = (ys.max() + my, ys.min() - my)  # inverted (tablet Y down)
    for ax, ttl, col in ((axR, "Raw pen input  ·  hand tremor", RAW),
                         (axT, "With Tracey  ·  smoothed live", TRC)):
        ax.set_xlim(*xlim); ax.set_ylim(*ylim); ax.set_aspect("equal"); ax.axis("off")
        ax.set_title(ttl, fontsize=12, color=col, weight="bold", pad=6)
    lnR, = axR.plot([], [], color=RAW, lw=1.5, solid_capstyle="round", solid_joinstyle="round")
    lnT, = axT.plot([], [], color=TRC, lw=1.9, solid_capstyle="round", solid_joinstyle="round")
    tipR, = axR.plot([], [], "o", color=RAW, ms=9, mec="white", mew=1.2)
    tipT, = axT.plot([], [], "o", color=TRC, ms=9, mec="white", mew=1.2)
    fig.suptitle("Tracey removes hand tremor from pen input, in real time",
                 fontsize=13.5, weight="bold", y=0.99)
    # Two lines, same as the spiral demo, and for the same reason: as one line this
    # overflows an 828px figure at 8.5pt and gets clipped at BOTH ends because it is
    # centred. Line one is provenance and MUST keep saying the stroke is synthetic.
    fig.text(0.5, 0.018,
             f"Synthetic straight stroke · {a.hz:.1f} Hz tremor · same motion, drawn in sync\n"
             f"4-8 Hz tremor -{removed:.0f}% at Steadiest, ink trails the pen by {dev:.1f} px · "
             f"illustration, not a patient recording",
             ha="center", va="bottom", fontsize=8.5, color="#555", linespacing=1.6)

    step = max(1, n // 100)
    frames = list(range(step, n, step)) + [n] * 18      # draw, then hold before looping

    def update(k):
        lnR.set_data(px[:k], py[:k]); lnT.set_data(fx[:k], fy[:k])
        j = min(k, n) - 1
        tipR.set_data([px[j]], [py[j]]); tipT.set_data([fx[j]], [fy[j]])
        return lnR, lnT, tipR, tipT

    plt.tight_layout(rect=[0, 0.14, 1, 0.93])
    anim = FuncAnimation(fig, update, frames=frames, interval=50, blit=True)
    anim.save(a.out, writer=PillowWriter(fps=20), dpi=90)
    print("wrote", os.path.normpath(a.out),
          f"| {a.length / a.seconds:.0f} px/s | 4-8 Hz -{removed:.1f}% | dev {dev:.1f} px"
          f" | frames: {len(frames)} | points: {n}")


if __name__ == "__main__":
    main()
