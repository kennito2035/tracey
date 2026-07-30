#!/usr/bin/env python3
"""analyze_spirals.py - real-data feasibility probe for the v3 intent model.

Question: can any causal, template-FREE filter reduce a PD spiral's deviation from
the intended shape (i.e. "straighten the line")? Or is that deviation dominated by
low-frequency wander that no real-time filter can separate from intended motion?

Method (Static Spiral Test, testID=0 - patient traces a printed Archimedean spiral):
  1. Dedupe files by content hash (the "Improved" set duplicates Isenkul).
  2. Fit the intended spiral r = a + b*theta to each drawing (grid-search the center,
     least-squares a,b on unwrapped angle) - this is the best estimate of intent.
  3. Radial deviation d(t) = r(t) - (a + b*theta(t)) is the signed miss from intent.
  4. Split d(t) into a low-freq wander band (<2 Hz) and a tremor band (>=2 Hz).
     A causal low-pass can only touch the tremor band; the wander is un-filterable.
  5. Report, PD vs control: mean |deviation|, and how much of the deviation VARIANCE
     lives in the un-filterable wander band. Also: jitter (path length) for context.

No pandas/scipy - stdlib + numpy only. Data dir is gitignored; this script is not.
"""
import os, glob, hashlib, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
def _find_data():
    for c in (os.path.join(HERE, "data"), os.path.join(HERE, "..", "data"),
              os.path.join(HERE, "..", "v3", "data")):
        if os.path.isdir(c):
            return c
    return os.path.join(HERE, "data")   # default (data is gitignored; place it here)
DATA = _find_data()
# The archive's "Improved Spiral Test" folder is EXCLUDED, not deduplicated.
#
# It is a second copy of the base set, and MD5 dedup is not enough to catch it. Five of
# its fifteen "Healthy" files are the SAME five control subjects' same drawings with a
# handful of extra trailing samples, so they are not byte-identical and survived the
# hash - inflating the control arm from 15 subjects to 20. The pairing is unambiguous:
# C_0001/Healthy (1), C_0002/(2), C_0005/(5), C_0006/(6), C_0007/(7), each with
# identical Static-Spiral starting coordinates and sample counts within 0.6%.
#
# Excluding the folder outright makes the corpus exactly match UCI's own description of
# the dataset - 62 Parkinson's subjects and 15 healthy controls - of which 61 PD have a
# usable Static Spiral Test (one file's segment is empty).
#
# Cost of the old behaviour, for the record: control 4-8 Hz reduction read 4.9% instead
# of 16.3%, and the <2 Hz share 79.1% instead of 91.6%. No PD figure was affected, since
# every duplicate in the parkinson arm WAS byte-identical and the hash caught it.
GROUPS = {
    "control": [
        "parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/hw_dataset/control/*.txt",
    ],
    "parkinson": [
        "parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/hw_dataset/parkinson/*.txt",
        "parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/new_dataset/parkinson/*.txt",
    ],
}

def load(f):
    rows = []
    for ln in open(f):
        p = ln.strip().split(";")
        if len(p) >= 7:
            try: rows.append([float(p[0]), float(p[1]), float(p[3]), float(p[5]), int(p[6])])
            except: pass                     # X, Y, pressure, timestamp_ms, testID
    return np.array(rows) if rows else None

def unique_files(pats):
    seen, out = set(), []
    for pat in pats:
        for f in sorted(glob.glob(os.path.join(DATA, pat))):
            h = hashlib.md5(open(f, "rb").read()).hexdigest()
            if h not in seen: seen.add(h); out.append(f)
    return out

def static_spiral(a):
    """pen-down points of the Static Spiral Test (testID==0), time-ordered."""
    m = (a[:, 4] == 0) & (a[:, 2] > 0)
    seg = a[m]
    return seg[:, 0], seg[:, 1], seg[:, 3]      # x, y, t_ms

def fit_spiral(x, y):
    """Grid-search center, LSQ fit r=a+b*theta on unwrapped angle.

    Returns (deviation d(t), fit) where fit = (cx, cy, a, b, mask). The fit is
    returned so the FILTERED path can be scored against the very same intended
    spiral — measuring it against its own re-fit would silently let the filter
    move the target and flatter itself.
    """
    cx0, cy0 = x.mean(), y.mean()
    best = None
    for cx in np.linspace(cx0 - 30, cx0 + 30, 13):
        for cy in np.linspace(cy0 - 30, cy0 + 30, 13):
            r = np.hypot(x - cx, y - cy)
            th = np.unwrap(np.arctan2(y - cy, x - cx))
            w = r > np.percentile(r, 10)        # drop unstable near-center angles
            if w.sum() < 20: continue
            A = np.vstack([np.ones(w.sum()), th[w]]).T
            coef, res, *_ = np.linalg.lstsq(A, r[w], rcond=None)
            resid = r - (coef[0] + coef[1] * th)
            s = np.sqrt(np.mean(resid[w] ** 2))
            if best is None or s < best[0]:
                best = (s, resid, (cx, cy, coef[0], coef[1], w))
    return (best[1], best[2]) if best else (None, None)


def deviation_against(x, y, fit):
    """Deviation of an arbitrary path from an ALREADY-FITTED spiral."""
    cx, cy, a, b, _ = fit
    r = np.hypot(x - cx, y - cy)
    th = np.unwrap(np.arctan2(y - cy, x - cx))
    return r - (a + b * th)


def band_rms(d, fs, lo=None, hi=None):
    """RMS of d restricted to [lo,hi) Hz. None = open end."""
    d = d - d.mean()
    F = np.fft.rfft(d)
    f = np.fft.rfftfreq(len(d), 1.0 / fs)
    keep = np.ones_like(f, dtype=bool)
    if lo is not None: keep &= f >= lo
    if hi is not None: keep &= f < hi
    G = np.where(keep, F, 0)
    return float(np.sqrt(np.mean(np.fft.irfft(G, n=len(d)) ** 2)))

def band_split(d, t_ms, cut=2.0):
    """Return (wander_var, tremor_var): variance of deviation below/above `cut` Hz."""
    dt = np.diff(t_ms); dt = dt[(dt > 0) & (dt < 1000)]
    fs = 1000.0 / np.median(dt) if len(dt) else 143.0
    d = d - d.mean()
    F = np.fft.rfft(d); freq = np.fft.rfftfreq(len(d), 1.0 / fs)
    p = (np.abs(F) ** 2)
    lo = p[(freq > 0) & (freq < cut)].sum()
    hi = p[freq >= cut].sum()
    return lo, hi, fs

def oneeuro(x, t_ms, fmin, beta, dcut=1.0):
    def a(cut, dtp):
        tau = 1.0 / (2 * np.pi * cut); return 1.0 / (1.0 + tau / dtp)
    out = np.empty_like(x); xp = x[0]; dxp = 0.0; out[0] = x[0]
    for i in range(1, len(x)):
        dtp = (t_ms[i] - t_ms[i-1]) / 1000.0
        if dtp <= 0: dtp = 1/143.0
        dx = (x[i] - xp) / dtp
        dxp = dxp + a(dcut, dtp) * (dx - dxp)
        cut = fmin + beta * abs(dxp)
        xp = xp + a(cut, dtp) * (x[i] - xp)
        out[i] = xp
    return out

if not os.path.isdir(DATA) or not any(unique_files(p) for p in GROUPS.values()):
    print(f"No dataset found under {DATA}\n"
          "The spiral data is gitignored (redistributable but large). Download the Isenkul/Sakar\n"
          "'Parkinson disease spiral drawings' set from UCI and unzip it into that folder, then re-run.")
    raise SystemExit(0)

CUT = 2.0        # Hz: below this is intended motion / drift, above it is tremor

for grp, pats in GROUPS.items():
    files = unique_files(pats)
    devs, wfrac = [], []
    jit_raw, jit_oe = [], []
    tre_raw, tre_oe = [], []
    wan_raw, wan_oe = [], []
    exc_raw, exc_oe = [], []
    used = 0
    for f in files:
        a = load(f)
        if a is None: continue
        x, y, t = static_spiral(a)
        if len(x) < 200: continue
        d, fit = fit_spiral(x, y)
        if d is None: continue
        lo, hi, fs = band_split(d, t)

        # Filtered with the SHIPPED default preset, scored against the SAME spiral.
        xf = oneeuro(x, t, 0.40, 0.020); yf = oneeuro(y, t, 0.40, 0.020)
        df = deviation_against(xf, yf, fit)

        pl = lambda X, Y: np.hypot(np.diff(X), np.diff(Y)).sum()
        # "Excess path" = how much further the pen travelled than the intended
        # spiral requires. Total path length is dominated by the spiral itself, so
        # a 10% total reduction understates what happened to the shake; the excess
        # is the part that IS the shake.
        # Arc length of the fitted spiral over a MONOTONIC theta grid. Rebuilding it
        # at the raw thetas would carry the raw path's own angular jitter into the
        # "ideal", inflating it and understating the excess.
        thr = np.unwrap(np.arctan2(y - fit[1], x - fit[0]))
        tg = np.linspace(thr.min(), thr.max(), 2000)
        ideal = pl(fit[0] + (fit[2] + fit[3] * tg) * np.cos(tg),
                   fit[1] + (fit[2] + fit[3] * tg) * np.sin(tg))

        devs.append(np.mean(np.abs(d)))
        wfrac.append(lo / (lo + hi + 1e-9))
        jit_raw.append(pl(x, y));            jit_oe.append(pl(xf, yf))
        exc_raw.append(max(0.0, pl(x, y) - ideal))
        exc_oe.append(max(0.0, pl(xf, yf) - ideal))
        tre_raw.append(band_rms(d, fs, lo=CUT)); tre_oe.append(band_rms(df, fs, lo=CUT))
        wan_raw.append(band_rms(d, fs, hi=CUT)); wan_oe.append(band_rms(df, fs, hi=CUT))
        used += 1

    devs, wfrac = np.array(devs), np.array(wfrac)
    jr, jo = np.array(jit_raw), np.array(jit_oe)
    er, eo = np.array(exc_raw), np.array(exc_oe)
    tr, to = np.array(tre_raw), np.array(tre_oe)
    wr, wo = np.array(wan_raw), np.array(wan_oe)
    red = lambda A, B: 100 * (1 - B.mean() / (A.mean() + 1e-12))
    print(f"=== {grp}: {used} unique Static-Spiral drawings ===")
    print(f"  mean radial deviation from intended spiral   : {devs.mean():6.2f} px  (median {np.median(devs):.2f})")
    print(f"  deviation energy in UN-filterable <{CUT:.0f} Hz wander: {100*wfrac.mean():5.1f}%  (rest is tremor-band)")
    print(f"  --- what the filter does, by band ---")
    print(f"  TREMOR band (>={CUT:.0f} Hz) RMS  {tr.mean():6.2f} -> {to.mean():5.2f} px   REDUCED {red(tr,to):5.1f}%")
    print(f"  wander band (<{CUT:.0f} Hz)  RMS  {wr.mean():6.2f} -> {wo.mean():5.2f} px   changed {red(wr,wo):5.1f}%  (intended motion: should stay)")
    print(f"  excess path length (shake only)  {er.mean():7.1f} -> {eo.mean():6.1f} px   REDUCED {red(er,eo):5.1f}%")
    print(f"  total path length (incl. the spiral itself)   REDUCED {red(jr,jo):5.1f}%")
    print()

# Which preset actually does what, and to WHICH band. The headline number has to
# be the one that matches the shake a person can see: the clinical tremor bands
# are 4-6 Hz (Parkinson's rest) and 4-8 Hz (essential). Sample-to-sample jitter
# near Nyquist is digitizer noise and flatters any low-pass, so it is reported
# separately rather than folded into a single impressive-looking percentage.
PRESETS_SWEEP = [("Gentle", 0.70, 0.050), ("Balanced", 0.40, 0.020), ("Steadiest", 0.22, 0.010)]
BANDS = [("2-15 Hz  (all tremor)", 2.0, 15.0), ("4-8 Hz   (PD + essential)", 4.0, 8.0),
         (">15 Hz   (noise, not shake)", 15.0, None)]

print("=" * 78)
print("Tremor reduction by preset and band  (mean over the group, deviation RMS)")
print("=" * 78)
for grp, pats in GROUPS.items():
    files = unique_files(pats)
    acc = {(p[0], b[0]): [[], []] for p in PRESETS_SWEEP for b in BANDS}
    used = 0
    for f in files:
        a = load(f)
        if a is None: continue
        x, y, t = static_spiral(a)
        if len(x) < 200: continue
        d, fit = fit_spiral(x, y)
        if d is None: continue
        dt = np.diff(t); dt = dt[(dt > 0) & (dt < 1000)]
        fs = 1000.0 / np.median(dt) if len(dt) else 143.0
        for name, fmin, beta in PRESETS_SWEEP:
            xf = oneeuro(x, t, fmin, beta); yf = oneeuro(y, t, fmin, beta)
            df = deviation_against(xf, yf, fit)
            for bname, blo, bhi in BANDS:
                acc[(name, bname)][0].append(band_rms(d, fs, lo=blo, hi=bhi))
                acc[(name, bname)][1].append(band_rms(df, fs, lo=blo, hi=bhi))
        used += 1
    print(f"\n--- {grp} (n={used}) ---")
    for bname, _, _ in BANDS:
        row = f"  {bname:<28}"
        for name, _, _ in PRESETS_SWEEP:
            r, o = np.array(acc[(name, bname)][0]), np.array(acc[(name, bname)][1])
            row += f"  {name}: {100*(1-o.mean()/(r.mean()+1e-12)):5.1f}%"
        print(row)

# Can it be pushed further, and what does that cost?
#
# The one-euro's cutoff RISES with speed (the beta term), which is why a fast
# spiral passes so much tremor. Lowering fmin and beta removes more of it - and
# adds lag, which is the whole trade. Lag is reported as the visible thing:
# how far behind the pen the ink sits, in pixels.
print("\n" + "=" * 78)
print("Pushing harder: PD 4-8 Hz reduction vs the lag it costs")
print("=" * 78)
# The "removed p5" row is kept on purpose: it is what the core's old Ctrl+Alt+5
# selected, and this measurement is why that hotkey scale is gone. It removed
# 6.9% of the 4-8 Hz band against Steadiest's 19.0%, so the strongest-LOOKING
# setting was the weakest one. The core now ships the same three presets as the
# UI cards above it. Kept as the evidence, not as a shipping setting.
SETTINGS = [("Gentle    ", 0.70, 0.050), ("Balanced  ", 0.40, 0.020),
            ("Steadiest ", 0.22, 0.010), ("removed p5", 0.15, 0.080),
            ("heavy-1   ", 0.15, 0.005),
            ("heavy-2   ", 0.10, 0.002), ("heavy-3   ", 0.07, 0.001)]
files = unique_files(GROUPS["parkinson"])
res = {s[0]: [[], []] for s in SETTINGS}
used = 0
for f in files:
    a = load(f)
    if a is None: continue
    x, y, t = static_spiral(a)
    if len(x) < 200: continue
    d, fit = fit_spiral(x, y)
    if d is None: continue
    dt = np.diff(t); dt = dt[(dt > 0) & (dt < 1000)]
    fs = 1000.0 / np.median(dt) if len(dt) else 143.0
    base = band_rms(d, fs, lo=4.0, hi=8.0)
    for name, fmin, beta in SETTINGS:
        xf = oneeuro(x, t, fmin, beta); yf = oneeuro(y, t, fmin, beta)
        df = deviation_against(xf, yf, fit)
        res[name][0].append(band_rms(df, fs, lo=4.0, hi=8.0) / (base + 1e-12))
        res[name][1].append(float(np.mean(np.hypot(x - xf, y - yf))))   # ink-behind-pen, px
    used += 1
print(f"  (n={used} Parkinson's drawings)")
for name, fmin, beta in SETTINGS:
    keep = np.array(res[name][0]); lag = np.array(res[name][1])
    print(f"  {name} fmin={fmin:<5} beta={beta:<6}  4-8Hz REDUCED {100*(1-keep.mean()):5.1f}%"
          f"   ink lags pen by {lag.mean():5.2f} px")

# ---------------------------------------------------------------------------
# The 4-8 Hz row in VALIDATION.md sets control against Parkinson, so both cells
# have to be the SAME statistic. Two are defensible and they do not agree:
#
#   ratio-of-means : 1 - mean(filtered)/mean(raw). Weights each drawing by its
#                    absolute tremor amplitude, so the shakiest dominate. This is
#                    what the by-band table above reports.
#   mean-of-ratios : 1 - mean(filtered/raw). Weights every drawing equally, i.e.
#                    "what a typical hand gets". This is what the lag sweep above
#                    reports, and it is the published headline.
#
# They got mixed once: the control cell was quoted ratio-of-means (16.3%) beside a
# Parkinson cell quoted mean-of-ratios (19.0%), which is not a comparison at all.
# Both are printed here so neither can be quoted without its pair.
print()
print("=" * 78)
print("4-8 Hz reduction, both statistics, both groups (the VALIDATION.md row)")
print("=" * 78)
print(f"  {'group':<11}{'preset':<11}{'ratio-of-means':>16}{'mean-of-ratios':>16}   n")
for _grp in ("control", "parkinson"):
    for _name, _fmin, _beta in PRESETS_SWEEP:
        _raw, _flt, _rat = [], [], []
        for _f in unique_files(GROUPS[_grp]):
            _a = load(_f)
            if _a is None: continue
            _x, _y, _t = static_spiral(_a)
            if len(_x) < 200: continue
            _d, _fit = fit_spiral(_x, _y)
            if _d is None: continue
            _dt = np.diff(_t); _dt = _dt[(_dt > 0) & (_dt < 1000)]
            _fs = 1000.0 / np.median(_dt) if len(_dt) else 143.0
            _xf = oneeuro(_x, _t, _fmin, _beta); _yf = oneeuro(_y, _t, _fmin, _beta)
            _df = deviation_against(_xf, _yf, _fit)
            _r = band_rms(_d, _fs, lo=4.0, hi=8.0)
            _fl = band_rms(_df, _fs, lo=4.0, hi=8.0)
            _raw.append(_r); _flt.append(_fl); _rat.append(_fl / (_r + 1e-12))
        _rom = 100 * (1 - np.mean(_flt) / np.mean(_raw))
        _mor = 100 * (1 - np.mean(_rat))
        print(f"  {_grp:<11}{_name:<11}{_rom:15.1f}%{_mor:15.1f}%   {len(_rat)}")
