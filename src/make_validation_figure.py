#!/usr/bin/env python3
"""make_validation_figure.py - hero before/after figure from real spiral data.

Full-spiral scale hides the effect, because most of a spiral's path length IS the
spiral. So we show it the way tremor papers do: overlay the raw pen path and
Tracey's path on the SAME axes, and zoom into the shakiest segment.

THE FILTER SETTING MUST BE ONE A USER CAN ACTUALLY PICK. This used to run at
fmin=0.15 beta=0.012, which is in neither preset table - close to Steadiest in
effect, but not a setting any user can select. It now uses the UI's Steadiest card
verbatim, so the figure shows exactly what clicking Steadiest does. Measured on all
61 PD drawings at this setting: 4-8 Hz tremor -19.0%, intended motion (<2 Hz)
changed by 1.0%, ink trailing the pen by 4.25 px. That last pair must be quoted at
THIS preset: the sub-1% figure VALIDATION used to print here is the Balanced one
(0.64%), and the caption is rendered at Steadiest.

Output PNG is committed as a submission asset (the dataset is gitignored, so it cannot be
regenerated without restoring it first).
"""
# The "Steadiest" setting, verbatim from ui/electron/core-comms.js PRESETS. The C core
# ships the same three presets now (tracey.c PRESETS, Ctrl+Alt+3), so this is one number
# in one place. It used to be two: the core's old preset 5 (0.15/0.080) was far lighter
# in practice, 6.9% in the 4-8 Hz band, because its high beta let the cutoff climb with
# speed. That table is gone.
STEADIEST = (0.22, 0.010)
import os, glob, hashlib, numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

HERE = os.path.dirname(os.path.abspath(__file__))
def _find_data():
    for c in (os.path.join(HERE, "data"), os.path.join(HERE, "..", "data"),
              os.path.join(HERE, "..", "v3", "data")):
        if os.path.isdir(c):
            return c
    return os.path.join(HERE, "data")
def _find_out():
    for c in (os.path.join(HERE, "..", "tracey-handoff"), os.path.join(HERE, "..")):
        if os.path.exists(os.path.join(c, "VALIDATION.md")):
            return c
    return HERE
DATA = _find_data()
OUT  = os.path.join(_find_out(), "validation_spiral.png")

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

def deviation(x, y):
    cx, cy = x.mean(), y.mean()
    r = np.hypot(x - cx, y - cy); th = np.unwrap(np.arctan2(y - cy, x - cx))
    w = r > np.percentile(r, 10)
    if w.sum() < 20: return 1e9
    c = np.linalg.lstsq(np.vstack([np.ones(w.sum()), th[w]]).T, r[w], rcond=None)[0]
    return np.mean(np.abs(r - (c[0] + c[1] * th)))

def pick(pats, q):
    """rank drawings by how much high-frequency jitter Tracey removes PER SAMPLE (the
    visible shake it acts on - NOT deviation, which is low-freq wander it can't touch),
    and return the one at quantile q. This is where the smoothing actually shows."""
    pl = lambda X, Y: np.hypot(np.diff(X), np.diff(Y)).sum()
    cand = []
    for f in uniq(pats):
        a = load(f)
        if a is None: continue
        x, y, t = static(a)
        if len(x) < 300: continue
        fx = oneeuro(x, t, *STEADIEST); fy = oneeuro(y, t, *STEADIEST)
        cand.append(((pl(x, y) - pl(fx, fy)) / len(x), f))   # px of shake removed / sample
    cand.sort()
    return cand[int(q * (len(cand) - 1))][1]

def shakiest_window(x, y, W):
    """window with the most tremor while still being a *directional* arc (not a scribble
    knot) - so the before/after reads cleanly instead of a tangle."""
    j = np.abs(np.diff(x, 2)) + np.abs(np.diff(y, 2))
    cs = np.concatenate([[0], np.cumsum(j)])
    best, bi = -1, 0
    for i in range(0, len(j) - W):
        tremor = cs[i + W] - cs[i]
        seg = slice(i, i + W)
        arc = np.hypot(np.diff(x[seg]), np.diff(y[seg])).sum()
        chord = np.hypot(x[i + W] - x[i], y[i + W] - y[i])
        direction = chord / (arc + 1e-9)          # ~1 = sweeping arc, ~0 = knot
        if direction < 0.45:
            continue
        if tremor > best: best, bi = tremor, i
    return bi

if not os.path.isdir(DATA) or not uniq(["**/*.txt"]):
    raise SystemExit(f"No dataset under {DATA} - place the Isenkul/Sakar spiral set there to regenerate.")

pd_f = pick(["parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/hw_dataset/parkinson/*.txt",
             "parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/new_dataset/parkinson/*.txt"], 1.0)
px, py, pt = static(load(pd_f))
fx = oneeuro(px, pt, *STEADIEST); fy = oneeuro(py, pt, *STEADIEST)     # the UI's Steadiest card

W = max(60, len(px) // 12)
bi = shakiest_window(px, py, W); sl = slice(bi, bi + W)
pad = 0.15
x0, x1 = px[sl].min(), px[sl].max(); y0, y1 = py[sl].min(), py[sl].max()
dx, dy = (x1 - x0), (y1 - y0); m = max(dx, dy) * (1 + pad)
cxm, cym = (x0 + x1) / 2, (y0 + y1) / 2
zx = (cxm - m/2, cxm + m/2); zy = (cym - m/2, cym + m/2)

RAW, TRC = "#e53935", "#1565c0"
fig, (axF, axZ) = plt.subplots(1, 2, figsize=(12, 6.2), gridspec_kw={"width_ratios": [1, 1]})
fig.patch.set_facecolor("white")

# left: whole spiral, both paths overlaid (raw underneath so its shake pokes out), + zoom box
axF.plot(px, py, color=RAW, lw=1.3, alpha=0.9, label="raw pen input (tremor)", solid_capstyle="round")
axF.plot(fx, fy, color=TRC, lw=1.4, label="with Tracey", solid_capstyle="round")
axF.add_patch(Rectangle((zx[0], zy[0]), m, m, fill=False, ec="#333", lw=1.3, ls=(0, (4, 3))))
axF.set_title("A real Parkinson's spiral, filtered live", fontsize=12.5, color="#222", pad=8)
axF.set_aspect("equal"); axF.axis("off"); axF.invert_yaxis()
axF.legend(loc="lower left", frameon=False, fontsize=10.5)

# right: zoom into the shakiest arc - thin lines so the real tremor zigzag shows honestly
zsl = slice(max(0, bi - 12), bi + W + 12)
axZ.plot(px[zsl], py[zsl], color=RAW, lw=2.0, alpha=0.9, solid_capstyle="round")
axZ.plot(fx[zsl], fy[zsl], color=TRC, lw=2.6, solid_capstyle="round")
axZ.set_xlim(*zx); axZ.set_ylim(*zy); axZ.invert_yaxis()
axZ.set_aspect("equal")
axZ.set_xticks([]); axZ.set_yticks([])
for s in axZ.spines.values(): s.set_edgecolor("#333"); s.set_linestyle((0, (4, 3)))
axZ.set_title("Zoomed in: the shake, smoothed away", fontsize=12.5, color="#222", pad=8)

fig.suptitle("Tracey removes hand tremor from real pen input   ·   validated on 61 Parkinson's patients + 15 controls",
             fontsize=13.5, weight="bold", y=0.99)
# Numbers, not adjectives - and the caveats a reviewer would otherwise raise first:
# which drawing this is, and that the zoom's staircase is partly tablet quantisation.
fig.text(0.5, 0.055,
         "Static Spiral Test (Isenkul/Sakar). Red = the patient's raw pen path; blue = the same stroke through Tracey, "
         "'Steadiest' preset (fmin 0.22, beta 0.010).",
         ha="center", fontsize=9, color="#555")
fig.text(0.5, 0.028,
         "Measured across all 61 patients at this setting:  4-8 Hz tremor band  -19%   ·   "
         "intended motion (<2 Hz) changed by 1%   ·   ink trails the pen by 4.3 px.",
         ha="center", fontsize=9.5, color="#222", weight="bold")
fig.text(0.5, 0.004,
         "Shown: the most tremulous of the 61 drawings, so the effect is visible at print size. "
         "Part of the fine red stepping is tablet quantisation, not tremor.",
         ha="center", fontsize=7.8, color="#777")
plt.tight_layout(rect=[0, 0.085, 1, 0.96])
plt.savefig(OUT, dpi=150, bbox_inches="tight", facecolor="white")
print("wrote", os.path.normpath(OUT), "| PD:", os.path.basename(pd_f))
