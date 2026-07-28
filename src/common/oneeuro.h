/* oneeuro.h - One-Euro filter (Casiez et al. 2012), header-only C.
 * Port of core/filter_1euro.py. One instance per axis per contact point. */
#ifndef ONEEURO_H
#define ONEEURO_H

#include <math.h>

#ifndef ONEEURO_PI
#define ONEEURO_PI 3.14159265358979323846
#endif

typedef struct {
    double fmin;      /* min cutoff (Hz); lower = more filtering at rest */
    double beta;      /* speed coefficient; higher = less lag on fast motion */
    double d_cutoff;  /* derivative low-pass cutoff (Hz) */
    double x_prev;    /* last filtered value */
    double dx_prev;   /* last filtered derivative */
    double t_prev;    /* last timestamp (s) */
    int    primed;
} OneEuro;

static void oneeuro_init(OneEuro *f, double fmin, double beta, double d_cutoff) {
    f->fmin = fmin; f->beta = beta; f->d_cutoff = d_cutoff;
    f->x_prev = 0.0; f->dx_prev = 0.0; f->t_prev = 0.0; f->primed = 0;
}

static void oneeuro_reset(OneEuro *f) {
    f->x_prev = 0.0; f->dx_prev = 0.0; f->t_prev = 0.0; f->primed = 0;
}

static double oneeuro_alpha(double cutoff, double dt) {
    double r = 2.0 * ONEEURO_PI * cutoff * dt;
    return r / (r + 1.0);
}

/* Feed sample x at timestamp t (seconds, monotonically increasing). */
static double oneeuro_filter(OneEuro *f, double x, double t) {
    if (!f->primed) { f->primed = 1; f->x_prev = x; f->t_prev = t; return x; }
    double dt = t - f->t_prev;
    if (dt <= 0.0) return f->x_prev;

    double dx_raw  = (x - f->x_prev) / dt;
    double alpha_d = oneeuro_alpha(f->d_cutoff, dt);
    double dx_hat  = alpha_d * dx_raw + (1.0 - alpha_d) * f->dx_prev;

    double fc    = f->fmin + f->beta * fabs(dx_hat);
    double alpha = oneeuro_alpha(fc, dt);
    double x_hat = alpha * x + (1.0 - alpha) * f->x_prev;

    f->x_prev = x_hat; f->dx_prev = dx_hat; f->t_prev = t;
    return x_hat;
}

#endif /* ONEEURO_H */
