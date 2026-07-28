/* tremor_tracker.h - v3 real-time tremor frequency tracker (header-only C).
 *
 * Signal processing, NOT machine learning - needs no training data. It keeps a
 * sliding window of recent pen positions, linear-detrends it (removing slow
 * intended motion), Hann-windows it, and runs a small radix-2 FFT to find the
 * dominant frequency in the tremor band (~3-15 Hz). That measured frequency
 * feeds tt_adaptive_fmin(), which sets the one-euro filter cutoff to attenuate
 * *this user's* tremor in real time.
 *
 * On a steady hand there is no clear peak and it reports freq=0 (no adaptation).
 * Validate the DSP with test_tracker.c (synthetic sine -> known frequency).
 */
#ifndef TREMOR_TRACKER_H
#define TREMOR_TRACKER_H

#include <math.h>
#include <string.h>

#define TT_N       128        /* FFT window (power of 2); ~0.85 s at 150 Hz */
#define TT_FMIN_HZ 3.0        /* tremor search band low edge  */
#define TT_FMAX_HZ 15.0       /* tremor search band high edge */
#define TT_MIN_STRENGTH 0.15  /* peak power / total power gate for "real tremor" */
#ifndef TT_PI
#define TT_PI 3.14159265358979323846
#endif

typedef struct {
    double bx[TT_N], by[TT_N];   /* raw positions, circular buffer */
    int    head, count;
    double t_prev, dt_acc; int dt_n;   /* mean-dt estimate -> sample rate */
    double freq_hz;              /* last estimate, 0 if no clear tremor */
    double strength;             /* peak power fraction, 0..1 */
} TremorTracker;

static void tt_init(TremorTracker *t) { memset(t, 0, sizeof(*t)); }

/* Feed one raw pen sample (x,y) at time t_s (seconds, increasing). */
static void tt_push(TremorTracker *t, double x, double y, double t_s) {
    if (t->count > 0) {
        double dt = t_s - t->t_prev;
        if (dt > 0.0 && dt < 0.1) { t->dt_acc += dt; t->dt_n++; }  /* skip pen-lift gaps */
    }
    t->t_prev = t_s;
    t->bx[t->head] = x; t->by[t->head] = y;
    t->head = (t->head + 1) % TT_N;
    if (t->count < TT_N) t->count++;
}

/* --- internals --- */
static void tt_detrend(double *a, int n) {
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (int i = 0; i < n; i++) { sx += i; sy += a[i]; sxx += (double)i * i; sxy += (double)i * a[i]; }
    double d = (double)n * sxx - sx * sx;
    double slope = (d != 0.0) ? ((double)n * sxy - sx * sy) / d : 0.0;
    double inter = (sy - slope * sx) / n;
    for (int i = 0; i < n; i++) a[i] -= (inter + slope * i);
}

static void tt_fft(double *re, double *im, int n) {
    for (int i = 1, j = 0; i < n; i++) {          /* bit-reversal permutation */
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { double t; t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (int len = 2; len <= n; len <<= 1) {
        double ang = -2.0 * TT_PI / len, wr = cos(ang), wi = sin(ang);
        for (int i = 0; i < n; i += len) {
            double cwr = 1.0, cwi = 0.0;
            for (int k = 0; k < len / 2; k++) {
                double ur = re[i + k], ui = im[i + k];
                double vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
                double vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                double nwr = cwr * wr - cwi * wi, nwi = cwr * wi + cwi * wr;
                cwr = nwr; cwi = nwi;
            }
        }
    }
}

/* Recompute the dominant tremor frequency from the current window. */
static void tt_analyze(TremorTracker *t) {
    if (t->count < TT_N || t->dt_n < 8) return;
    double fs = (double)t->dt_n / t->dt_acc;      /* samples per second */
    if (fs <= 0.0) return;

    double rex[TT_N], imx[TT_N], rey[TT_N], imy[TT_N];
    for (int i = 0; i < TT_N; i++) {              /* oldest-first (buffer is full) */
        int idx = (t->head + i) % TT_N;
        rex[i] = t->bx[idx]; rey[i] = t->by[idx]; imx[i] = imy[i] = 0.0;
    }
    tt_detrend(rex, TT_N); tt_detrend(rey, TT_N);
    for (int i = 0; i < TT_N; i++) {              /* Hann window */
        double w = 0.5 - 0.5 * cos(2.0 * TT_PI * i / (TT_N - 1));
        rex[i] *= w; rey[i] *= w;
    }
    tt_fft(rex, imx, TT_N); tt_fft(rey, imy, TT_N);

    int kmin = (int)ceil(TT_FMIN_HZ * TT_N / fs);  if (kmin < 1) kmin = 1;
    int kmax = (int)floor(TT_FMAX_HZ * TT_N / fs); if (kmax > TT_N / 2) kmax = TT_N / 2;
    double pw[TT_N / 2];
    double best = 0.0, total = 0.0; int bestk = -1;
    for (int k = 1; k < TT_N / 2; k++) {
        pw[k] = rex[k]*rex[k] + imx[k]*imx[k] + rey[k]*rey[k] + imy[k]*imy[k];
        total += pw[k];
        if (k >= kmin && k <= kmax && pw[k] > best) { best = pw[k]; bestk = k; }
    }
    /* Reject a "peak" that is only the SHOULDER of sub-band drift.
     *
     * The search starts at kmin, so when the winning bin IS kmin nothing stops it
     * from being the skirt of the huge sub-3 Hz drift the band exists to exclude.
     * Measured with no tremor in the signal at all: any drawing motion carrying
     * 1.5-2.5 Hz reported exactly the lowest in-band bin — 3.12 Hz at fs=200,
     * 3.52 Hz at fs=150 — at every amplitude tried, and passed the strength gate
     * comfortably, because the drift really is the dominant energy. Real steady-
     * hand calibrations duly came back 3.48 / 3.70 / 4.09 Hz.
     *
     * A genuine tremor peak is a local maximum: the bin below it is smaller. A
     * leakage shoulder is not — it is still descending from the drift. So if the
     * peak sits on the band floor and the bin below it (out of band, by
     * construction) is larger, there is no tremor here. tt_detrend removes only a
     * LINEAR ramp, which is why a curved scribble leaves this much behind.
     *
     * bestk > 1 because pw[0] is never computed; the loop starts at k = 1. */
    int floor_shoulder = (bestk == kmin && bestk > 1 && pw[bestk - 1] > pw[bestk]);
    if (bestk > 0 && !floor_shoulder && total > 0.0 && best / total >= TT_MIN_STRENGTH) {
        /* Parabolic sub-bin refine.
         *
         * Only valid at a TRUE local maximum. The search is restricted to
         * [kmin,kmax], but the refinement looks at bestk-1 and bestk+1, which
         * are not — so when the peak sits on the band floor, bestk-1 is the
         * huge sub-3 Hz drift bin that the band exists to exclude. Fitting a
         * parabola through a non-peak makes the correction unbounded as
         * denom -> 0, and it threw the estimate clean out of the band: a real
         * 200 Hz calibration reported 1.56 Hz, and synthetic drift cases here
         * reached -21.94 Hz. So: refine only when the middle bin really is the
         * largest of the three, require the parabola to open downwards, and
         * clamp the shift to the half-bin it can never legitimately exceed. */
        double kf = bestk;
        if (bestk > 1 && bestk < TT_N / 2 - 1) {
            double a = pw[bestk - 1], b = pw[bestk], c = pw[bestk + 1];
            double denom = a - 2.0 * b + c;
            if (b >= a && b >= c && denom < 0.0) {
                double shift = 0.5 * (a - c) / denom;
                if (shift >  0.5) shift =  0.5;
                if (shift < -0.5) shift = -0.5;
                kf = bestk + shift;
            }
        }
        double f = kf * fs / (double)TT_N;
        /* Belt and braces: we searched a band, so the answer belongs to it.
         * A half-bin refinement at the edge can still land just outside. */
        if (f < TT_FMIN_HZ) f = TT_FMIN_HZ;
        if (f > TT_FMAX_HZ) f = TT_FMAX_HZ;
        t->freq_hz = f;
        t->strength = best / total;
    } else {
        t->freq_hz = 0.0; t->strength = 0.0;
    }
}

/* Map the measured tremor frequency to a one-euro fmin. With no clear tremor,
 * returns the caller's baseline (calibrated) fmin unchanged. A first-order
 * low-pass at cutoff fc attenuates frequency f by ~fc/f, so fc = atten*f_tremor
 * targets a fixed attenuation (default ~-12 dB) at the tremor frequency. */
static double tt_adaptive_fmin(const TremorTracker *t, double baseline_fmin) {
    if (t->freq_hz <= 0.0) return baseline_fmin;
    double fmin = 0.25 * t->freq_hz;              /* ~ -12 dB at the tremor peak */
    if (fmin < 0.15) fmin = 0.15;
    if (fmin > 3.0)  fmin = 3.0;
    return fmin;
}

#endif /* TREMOR_TRACKER_H */
