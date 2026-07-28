/* notch.h - adaptive biquad notch (band-stop) for tremor removal.
 *
 * Removes a narrow band around a center frequency (the tremor frequency found
 * by tremor_tracker.h) while passing everything else. Unlike a low-pass, it
 * keeps BOTH slow intended motion AND fine detail, and it suppresses the tremor
 * oscillation regardless of stroke speed — where the one-euro filter's cutoff
 * rises with speed and lets tremor through during fast strokes.
 *
 * Header-only C. Standard RBJ notch biquad, Direct Form II Transposed.
 * One instance per axis; retune with notch_design() as the tracked freq updates.
 */
#ifndef NOTCH_H
#define NOTCH_H

#include <math.h>

#ifndef NOTCH_PI
#define NOTCH_PI 3.14159265358979323846
#endif

typedef struct {
    double b0, b1, b2, a1, a2;   /* coefficients (a0 normalized to 1) */
    double z1, z2;               /* DF2T state */
    int    active;               /* 0 = passthrough (invalid design) */
} Notch;

/* Design a notch at f0 Hz for sample rate fs Hz, quality Q (higher = narrower).
 * Passthrough if f0/fs/Q are invalid (f0<=0, f0>=Nyquist, etc.). Q ~ 3..6 gives
 * a tremor-width band (bandwidth = f0/Q). */
/* Sets coefficients only (keeps filter state, so it can retune mid-stream
 * without a click). Call notch_reset() once before first use / at stroke start. */
static void notch_design(Notch *n, double f0, double fs, double Q) {
    if (f0 <= 0.0 || fs <= 0.0 || Q <= 0.0 || f0 >= 0.5 * fs) {
        n->b0 = 1.0; n->b1 = n->b2 = n->a1 = n->a2 = 0.0; n->active = 0;
        return;
    }
    double w0 = 2.0 * NOTCH_PI * f0 / fs;
    double cw = cos(w0), alpha = sin(w0) / (2.0 * Q);
    double a0 = 1.0 + alpha;
    n->b0 =  1.0 / a0;
    n->b1 = -2.0 * cw / a0;
    n->b2 =  1.0 / a0;
    n->a1 = -2.0 * cw / a0;
    n->a2 = (1.0 - alpha) / a0;
    n->active = 1;
}

static void notch_reset(Notch *n) { n->z1 = n->z2 = 0.0; }

static double notch_process(Notch *n, double x) {
    double y = n->b0 * x + n->z1;
    n->z1 = n->b1 * x - n->a1 * y + n->z2;
    n->z2 = n->b2 * x - n->a2 * y;
    return y;
}

#endif /* NOTCH_H */
