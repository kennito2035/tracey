#!/usr/bin/env python3
"""analyze_tremor_detect.py - does the tremor-frequency tracker actually work?

Question this answers: on REAL pen traces, how often does tremor_tracker.h claim a
tremor frequency for a hand that does not have one, and does it find the tremor in
a hand that does? A steady hand on the dev tablet kept reporting a confident
number (3.5 Hz, then 4 Hz, then 10 Hz), which is the symptom that prompted this.

Method: tt_analyze() is ported faithfully below - same TT_N, same linear detrend,
same Hann window, same 3-15 Hz search, same strength gate, same parabolic refine
with its guards, same floor-shoulder guard. It is then run over the Static Spiral
Test traces of the deduplicated Isenkul/Sakar set exactly the way the core runs it
during calibration: a window every 16 samples.

Two readout rules are compared, because the core changed from one to the other:
  LAST  - analyse once, at the end of the run (the original behaviour)
  LATCH - keep the window with the highest strength seen during the run (added to
          survive a pen lift late in the scribble)

No pandas/scipy - stdlib + numpy only. Data dir is gitignored; this script is not.
"""
import os, glob, hashlib, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# --- mirror of tremor_tracker.h -------------------------------------------
TT_N = 128
TT_FMIN_HZ = 3.0
TT_FMAX_HZ = 15.0
TT_MIN_STRENGTH = 0.15
STEP = 16                      # core re-analyses every 16th sample

GROUPS = {
    "control": ["parkinson+disease+spiral+drawings+using+digitized+graphics+tablet/hw_dataset/control/*.txt"],
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
            try:
                rows.append([float(p[0]), float(p[1]), float(p[3]), float(p[5]), int(p[6])])
            except ValueError:
                pass
    return np.array(rows) if rows else None


def unique_files(pats):
    seen, out = set(), []
    for pat in pats:
        for f in sorted(glob.glob(os.path.join(DATA, pat))):
            h = hashlib.md5(open(f, "rb").read()).hexdigest()
            if h not in seen:
                seen.add(h)
                out.append(f)
    return out


def static_spiral(a):
    m = (a[:, 4] == 0) & (a[:, 2] > 0)
    seg = a[m]
    return seg[:, 0], seg[:, 1], seg[:, 3]


def tt_analyze(bx, by, fs, floor_guard=True, highpass=None):
    """One window. Returns (freq_hz, strength); 0.0 means 'no tremor'."""
    x = np.asarray(bx, float).copy()
    y = np.asarray(by, float).copy()

    if highpass is not None:                    # experimental: kill the drift first
        x = x - _lowpass(x, fs, highpass)
        y = y - _lowpass(y, fs, highpass)

    n = TT_N
    i = np.arange(n)
    for a in (x, y):                            # tt_detrend: linear only
        A = np.vstack([np.ones(n), i]).T
        coef, *_ = np.linalg.lstsq(A, a, rcond=None)
        a -= coef[0] + coef[1] * i
    w = 0.5 - 0.5 * np.cos(2.0 * np.pi * i / (n - 1))
    X = np.fft.fft(x * w)
    Y = np.fft.fft(y * w)

    kmin = max(1, int(np.ceil(TT_FMIN_HZ * n / fs)))
    kmax = min(n // 2, int(np.floor(TT_FMAX_HZ * n / fs)))
    pw = np.abs(X[: n // 2]) ** 2 + np.abs(Y[: n // 2]) ** 2
    pw[0] = 0.0
    total = pw[1: n // 2].sum()
    if total <= 0 or kmin > kmax:
        return 0.0, 0.0
    band = pw[kmin: kmax + 1]
    bestk = kmin + int(np.argmax(band))
    best = pw[bestk]

    # Floor-shoulder guard. Mirrors tremor_tracker.h:192-193 EXACTLY, INCLUDING the
    # high-pass clause added in PROGRESS_ANCHOR 8f:
    #     bestk == kmin && bestk > 1 && (TT_HP_HZ > 0.0 || pw[bestk-1] > pw[bestk])
    # With the high-pass on, the floor bin is rejected OUTRIGHT rather than only when
    # the bin below is larger - because the high-pass attenuates pw[kmin-1] along with
    # the drift, so the shoulder stops looking like a shoulder and the comparison
    # silently stops firing. `highpass is not None` is the runtime equivalent of the C
    # compile-time constant TT_HP_HZ > 0.
    #
    # This clause was MISSING here from 2026-07-29 until it was caught by the live
    # 250 Hz recordings: without it this script accepts floor-bin peaks the shipped
    # core rejects, so every number it printed for the high-pass case described an
    # algorithm that does not ship.
    if (floor_guard and bestk == kmin and bestk > 1
            and (highpass is not None or pw[bestk - 1] > pw[bestk])):
        return 0.0, 0.0
    if best / total < TT_MIN_STRENGTH:
        return 0.0, 0.0

    kf = float(bestk)
    if 1 < bestk < n // 2 - 1:
        a_, b_, c_ = pw[bestk - 1], pw[bestk], pw[bestk + 1]
        denom = a_ - 2.0 * b_ + c_
        if b_ >= a_ and b_ >= c_ and denom < 0.0:
            kf = bestk + max(-0.5, min(0.5, 0.5 * (a_ - c_) / denom))
    f = kf * fs / n
    return float(min(TT_FMAX_HZ, max(TT_FMIN_HZ, f))), float(best / total)


def _lowpass(a, fs, fc):
    """Zero-phase-ish moving average whose -3dB point is about fc."""
    k = max(1, int(round(fs / (2.0 * fc))))
    ker = np.ones(k) / k
    pad = np.r_[np.full(k, a[0]), a, np.full(k, a[-1])]
    return np.convolve(pad, ker, mode="same")[k:-k]


CAL_HZ_MIN_PCT = 10          # matches CAL_HZ_MIN_PCT in tracey.c


def run_file(x, y, fs, **kw):
    """Every window the core would analyse.

    Returns (last, latch, persist, n_windows, n_hits) where
      last    - analyse once at the end            (original behaviour)
      latch   - strongest single window            (the regression)
      persist - median of hits, if >= CAL_HZ_MIN_PCT of windows hit (SHIPPED)
    """
    last = (0.0, 0.0)
    latch = (0.0, 0.0)
    seen = []
    nwin = hits = 0
    for s in range(0, len(x) - TT_N + 1, STEP):
        f, st = tt_analyze(x[s: s + TT_N], y[s: s + TT_N], fs, **kw)
        nwin += 1
        if f > 0:
            hits += 1
            seen.append(f)
            last = (f, st)
            if st > latch[1]:
                latch = (f, st)
        # a zero window does NOT clear `last`: the core only ever overwrites
        # freq_hz on a successful analyse, matching tt_analyze's else-branch...
        # except it DOES clear it. Mirror the C exactly:
        else:
            last = (0.0, 0.0)
    persist = float(np.median(seen)) if (nwin and hits * 100 >= nwin * CAL_HZ_MIN_PCT) else 0.0
    return last, latch, persist, nwin, hits


def summarize(tag, files, **kw):
    rows = []
    for f in files:
        a = load(f)
        if a is None:
            continue
        x, y, t = static_spiral(a)
        if len(x) < TT_N + STEP:
            continue
        dt = np.diff(t)
        dt = dt[(dt > 0) & (dt < 1000)]
        fs = 1000.0 / np.median(dt) if len(dt) else 143.0
        last, latch, persist, nwin, hits = run_file(x, y, fs, **kw)
        rows.append((os.path.basename(f), fs, last[0], latch[0], nwin, hits, persist))
    return rows


def report(title, **kw):
    print(f"\n=== {title} ===")
    print(f"{'group':<10} {'n':>3} {'LAST !=0':>10} {'LATCH !=0':>11} {'PERSIST !=0':>13} "
          f"{'windows w/ peak':>16}")
    out = {}
    for g, pats in GROUPS.items():
        rows = summarize(g, unique_files(pats), **kw)
        out[g] = rows
        last_hit = sum(1 for r in rows if r[2] > 0)
        latch_hit = sum(1 for r in rows if r[3] > 0)
        pers_hit = sum(1 for r in rows if r[6] > 0)
        frac = np.mean([r[5] / r[4] for r in rows]) if rows else 0.0
        print(f"{g:<10} {len(rows):>3} {last_hit:>6}/{len(rows):<3} {latch_hit:>7}/{len(rows):<3} "
              f"{pers_hit:>9}/{len(rows):<3} {frac:>15.1%}")
    return out


if __name__ == "__main__":
    print("Tracey tremor-detector, evaluated on real pen traces")
    print(f"TT_N={TT_N} band={TT_FMIN_HZ}-{TT_FMAX_HZ}Hz gate={TT_MIN_STRENGTH} step={STEP}")
    print("A CONTROL reporting a frequency is a FALSE POSITIVE.")

    report("as shipped (floor guard on, both readouts)")
    report("floor guard OFF (what it looked like before the guard)", floor_guard=False)
    report("with a 2.5 Hz high-pass ahead of the FFT", highpass=2.5)

    # ---- can ANY threshold separate the two groups? ----------------------
    # If the strongest in-band peak a subject ever produces does not separate PD
    # from control, then no gate/band tuning rescues this detector: the quantity
    # it thresholds simply does not carry the distinction.
    def peak_stats(files, **kw):
        out = []
        for f in files:
            a = load(f)
            if a is None:
                continue
            x, y, t = static_spiral(a)
            if len(x) < TT_N + STEP:
                continue
            dt = np.diff(t); dt = dt[(dt > 0) & (dt < 1000)]
            fs = 1000.0 / np.median(dt) if len(dt) else 143.0
            best = 0.0
            frac = []
            for s in range(0, len(x) - TT_N + 1, STEP):
                _, st = tt_analyze(x[s:s + TT_N], y[s:s + TT_N], fs, **kw)
                best = max(best, st)
                frac.append(st)
            out.append((best, float(np.mean(frac))))
        return out

    def auc(pos, neg):
        """P(random PD > random control); 0.5 = no information."""
        if not pos or not neg:
            return float("nan")
        wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
        return wins / (len(pos) * len(neg))

    def _auc_fast(pos, neg):
        """Vectorised twin of auc(), used only by the bootstrap below.

        auc() is a readable double loop, which is the right shape for a number printed
        once. At 20,000 resamples it takes minutes, so the bootstrap uses this instead.
        The two agree exactly on the real data, and that is asserted before the CI is
        printed rather than assumed.
        """
        d = pos[:, None] - neg[None, :]
        return float(((d > 0).sum() + 0.5 * (d == 0).sum()) / (pos.size * neg.size))

    def boot_ci(pos, neg, n=20000, seed=7):
        """Percentile bootstrap 95% CI on the AUC, each arm resampled with replacement.

        This is what makes "above chance" a claim rather than an assertion: the point
        estimate alone says nothing about how much of it is 15 controls' worth of luck.
        The LOWER bound is the number that matters. Seeded, so the published interval
        reproduces exactly instead of wobbling in the third decimal between runs.
        """
        p = np.asarray(pos, float)
        q = np.asarray(neg, float)
        if p.size == 0 or q.size == 0:
            return float("nan"), float("nan")
        rng = np.random.default_rng(seed)
        bs = np.empty(n)
        for i in range(n):
            bs[i] = _auc_fast(rng.choice(p, p.size, replace=True),
                              rng.choice(q, q.size, replace=True))
        lo, hi = np.percentile(bs, [2.5, 97.5])
        return float(lo), float(hi)

    for tag, kw in (("raw", {}), ("2.5 Hz high-pass", {"highpass": 2.5})):
        c = peak_stats(unique_files(GROUPS["control"]), **kw)
        p = peak_stats(unique_files(GROUPS["parkinson"]), **kw)
        print(f"\n=== separability, {tag} ===")
        for name, idx in (("strongest peak strength", 0), ("mean peak strength", 1)):
            cv = [r[idx] for r in c]
            pv = [r[idx] for r in p]
            a = auc(pv, cv)
            assert abs(a - _auc_fast(np.asarray(pv, float),
                                     np.asarray(cv, float))) < 1e-12, \
                "auc() and _auc_fast() disagree; the CI would not describe the printed AUC"
            print(f"  {name:<24} control med {np.median(cv):.3f} "
                  f"[{np.percentile(cv,25):.3f}-{np.percentile(cv,75):.3f}]   "
                  f"PD med {np.median(pv):.3f} "
                  f"[{np.percentile(pv,25):.3f}-{np.percentile(pv,75):.3f}]   "
                  f"AUC {a:.3f}")
            lo, hi = boot_ci(pv, cv)
            verdict = ("above chance" if lo > 0.5 else
                       "touches chance, cannot claim" if hi > 0.5 else
                       "BELOW chance")
            print(f"  {'':<24} 95% CI [{lo:.3f}, {hi:.3f}]  {verdict}   "
                  f"(n={len(cv)} controls is what makes it this wide)")
        print("  (AUC 0.5 = the measure carries no PD/control information at all)")
