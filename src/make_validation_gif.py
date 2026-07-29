#!/usr/bin/env python3
"""make_validation_gif.py - animated before/after from a real Parkinson's spiral.

Two panels drawing in sync: the raw shaky pen path (left) and the same stroke through
Tracey (right). Motion is the point - the jittering pen tip on the left vs the gliding
one on the right sells the tremor removal far better than a still can.

Real data, and a setting the user can actually select: the UI's Steadiest card. This
used to run at fmin=0.15 beta=0.012, which is in neither preset table. Keep this in
step with make_validation_figure.py, and with whatever the demo video is filmed at -
the C core's Ctrl+Alt+5 is NOT this setting and smooths roughly half as much.

Writes an optimized looping GIF (Pillow, no ffmpeg).
"""
# The UI's "Steadiest" card, verbatim from ui/electron/core-comms.js PRESETS.
STEADIEST = (0.22, 0.010)

import os, glob, hashlib, numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter

HERE = os.path.dirname(os.path.abspath(__file__))
def _find_data():
    for c in (os.path.join(HERE, "data"), os.path.join(HERE, "..", "data"),
              os.path.join(HERE, "..", "v3", "data")):
        if os.path.isdir(c): return c
    return os.path.join(HERE, "data")
def _find_out():
    for c in (os.path.join(HERE, "..", "tracey-handoff"), os.path.join(HERE, "..")):
        if os.path.exists(os.path.join(c, "VALIDATION.md")): return c
    return HERE
DATA = _find_data()
OUT  = os.path.join(_find_out(), "validation_demo.gif")

def load(f):
    rows = []
    for ln in open(f):
        p = ln.strip().split(";")
        if len(p) >= 7:
            try: rows.append([float(p[0]), float(p[1]), float(p[3]), float(p[5]), int(p[6])])
            except: pass
    return np.array(rows) if rows else None

def uniq(pats):
    seen, out = set(), []
    for pat in pats:
        for f in sorted(glob.glob(os.path.join(DATA, pat))):
            h = hashlib.md5(open(f, "rb").read()).hexdigest()
            if h not in seen: seen.add(h); out.append(f)
    return out

def static(a):
    m = (a[:, 4] == 0) & (a[:, 2] > 0); s = a[m]
    return s[:, 0], s[:, 1], s[:, 3]

def oneeuro(x, t_ms, fmin, beta, dcut=1.0):
    A = lambda c, dtp: 1.0 / (1.0 + (1.0 / (2 * np.pi * c)) / dtp)
    out = np.empty_like(x); xp = x[0]; dxp = 0.0; out[0] = x[0]
    for i in range(1, len(x)):
        dtp = (t_ms[i] - t_ms[i-1]) / 1000.0
        if dtp <= 0: dtp = 1/143.0
        dx = (x[i] - xp) / dtp
        dxp += A(dcut, dtp) * (dx - dxp)
        xp  += A(fmin + beta * abs(dxp), dtp) * (x[i] - xp)
        out[i] = xp
    return out

def pick(pats, q):
    pl = lambda X, Y: np.hypot(np.diff(X), np.diff(Y)).sum()
    cand = []
    for f in uniq(pats):
        a = load(f)
        if a is None: continue
        x, y, t = static(a)
        if len(x) < 300: continue
        fx = oneeuro(x, t, *STEADIEST); fy = oneeuro(y, t, *STEADIEST)
        cand.append(((pl(x, y) - pl(fx, fy)) / len(x), f))
    cand.sort()
    return cand[int(q * (len(cand) - 1))][1]

if not os.path.isdir(DATA) or not uniq(["**/*.txt"]):
    raise SystemExit(f"No dataset under {DATA} - place the Isenkul/Sakar spiral set there to regenerate.")

pd_f = pick(["parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/hw_dataset/parkinson/*.txt",
             "parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/new_dataset/parkinson/*.txt"], 1.0)
px, py, pt = static(load(pd_f))
fx = oneeuro(px, pt, *STEADIEST); fy = oneeuro(py, pt, *STEADIEST)
n = len(px)

RAW, TRC = "#e53935", "#1565c0"
fig, (axR, axT) = plt.subplots(1, 2, figsize=(9.2, 5.0))
fig.patch.set_facecolor("white")
xs = np.concatenate([px, fx]); ys = np.concatenate([py, fy])
mx = 0.06 * (xs.max() - xs.min()); my = 0.06 * (ys.max() - ys.min())
xlim = (xs.min() - mx, xs.max() + mx); ylim = (ys.max() + my, ys.min() - my)  # inverted (tablet Y down)
for ax, ttl, col in ((axR, "Raw pen input  ·  hand tremor", RAW), (axT, "With Tracey  ·  smoothed live", TRC)):
    ax.set_xlim(*xlim); ax.set_ylim(*ylim); ax.set_aspect("equal"); ax.axis("off")
    ax.set_title(ttl, fontsize=12, color=col, weight="bold", pad=6)
lnR, = axR.plot([], [], color=RAW, lw=1.5, solid_capstyle="round", solid_joinstyle="round")
lnT, = axT.plot([], [], color=TRC, lw=1.9, solid_capstyle="round", solid_joinstyle="round")
tipR, = axR.plot([], [], "o", color=RAW, ms=9, mec="white", mew=1.2)
tipT, = axT.plot([], [], "o", color=TRC, ms=9, mec="white", mew=1.2)
fig.suptitle("Tracey removes hand tremor from pen input, in real time",
             fontsize=13.5, weight="bold", y=0.99)
# TWO lines, not one. As a single line this caption was ~150 characters wide at
# 8.5pt in an 828px figure, so it overflowed and - being centred - was clipped at
# BOTH ends: it read "al Parkinson's spiral ... + 15 contr". va="bottom" anchors
# the whole block above the figure edge rather than leaving matplotlib to hang
# the second line off the bottom.
fig.text(0.5, 0.018,
         "Real Parkinson's spiral (Isenkul/Sakar) · same hand motion, drawn in sync\n"
         "4-8 Hz tremor -19%, intended motion unchanged · 61 patients + 15 controls",
         ha="center", va="bottom", fontsize=8.5, color="#555", linespacing=1.6)

step = max(1, n // 100)
frames = list(range(step, n, step)) + [n] * 18          # draw, then hold before looping
def update(k):
    lnR.set_data(px[:k], py[:k]); lnT.set_data(fx[:k], fy[:k])
    j = min(k, n) - 1
    tipR.set_data([px[j]], [py[j]]); tipT.set_data([fx[j]], [fy[j]])
    return lnR, lnT, tipR, tipT

plt.tight_layout(rect=[0, 0.09, 1, 0.95])   # 0.09, not 0.05: the caption is two lines now
anim = FuncAnimation(fig, update, frames=frames, interval=50, blit=True)
anim.save(OUT, writer=PillowWriter(fps=20), dpi=90)
print("wrote", os.path.normpath(OUT), "| PD:", os.path.basename(pd_f), "| frames:", len(frames), "| points:", n)
