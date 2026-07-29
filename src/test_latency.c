/* test_latency.c - how much delay does Tracey actually add?
 *
 * "End-to-end latency" is the number judges ask for, and it is NOT one number.
 * It decomposes into four terms, three of which are measurable here or from the
 * core's own telemetry, and one of which is not measurable in software at all:
 *
 *   1. tablet -> Windows delivers WM_POINTER   : not measurable from inside the
 *                                                process; bounded by the sample
 *                                                interval the core logs (3.8 ms)
 *   2. filter group delay                      : MEASURED HERE. Dominant term.
 *   3. filter -> InjectSyntheticPointerInput   : core telemetry, ~35 us
 *   4. injected pointer -> app -> screen       : the app's own render + display
 *                                                pipeline; identical with or
 *                                                without Tracey, so not "added"
 *
 * Term 2 is the whole story, and it is SPEED-DEPENDENT by construction. The
 * one-euro cutoff is fc = fmin + beta*|dx/dt|, so the faster the pen moves the
 * higher the cutoff and the less it lags. Quoting a single latency figure for a
 * one-euro filter is therefore wrong; this prints the curve.
 *
 * METHOD
 *   Ramp (steady state): drive the filter with a constant-velocity ramp until
 *   it settles. A first-order low-pass tracking a ramp settles to a constant
 *   spatial error e = tau*v, so the time lag is exactly e/v - no curve fitting,
 *   no correlation, no windowing choices to argue about.
 *
 *   Step (transient): 10-90% rise time on a position step, which is what a
 *   sudden direction change looks like.
 *
 *   Real trace: optional. Pass a file of "x y t_ms" lines (a real Parkinson's
 *   spiral, exported from the Isenkul/Sakar set) and it reports the lag that
 *   maximises cross-correlation between raw and filtered - the honest
 *   whole-drawing number, at whatever mix of speeds that person actually drew.
 *
 * Build:  cl /nologo /O2 /I common test_latency.c
 * Run:    test_latency.exe [trace.txt]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "common/oneeuro.h"

/* Measured on the XP-Pen Deco Mini7 V2: the core logs pen_gap_avg = 3.8 ms
 * across every real session, i.e. ~263 Hz. Not the 200 Hz assumed elsewhere. */
#define DT       0.0038
#define D_CUTOFF 1.0

typedef struct { const char *name; double fmin, beta; } Setting;

/* The three settings, which are now ONE table shared by the core (tracey.c
 * PRESETS, selected by Ctrl+Alt+1..3) and the UI (core-comms.js PRESETS).
 *
 * This file used to list eight rows, because the core carried a separate
 * five-step scale that shared only its middle entry with the UI's cards. The
 * comment here said outright that they were "a different table and NOT the
 * same", which was true and was the bug: four of the five hotkeys set values no
 * card could represent, and the one labelled "5 heavy" was the WEAKEST of the
 * lot on tremor (6.9% of the 4-8 Hz band against Steadiest's 19.0%). Reconciled
 * 2026-07-29. If these two tables ever diverge again, that is a bug. */
static const Setting SETTINGS[] = {
    { "Gentle",    0.70, 0.050 },
    { "Balanced",  0.40, 0.020 },
    { "Steadiest", 0.22, 0.010 },
};
#define NSET (int)(sizeof(SETTINGS)/sizeof(SETTINGS[0]))

/* Pen speeds in px/s. At 96 DPI, 200 px/s is about 5 cm/s - unhurried
 * handwriting. 1500 px/s is a fast confident sweep. */
static const double SPEEDS[] = { 50, 200, 600, 1500 };
#define NSPEED (int)(sizeof(SPEEDS)/sizeof(SPEEDS[0]))

/* Steady-state lag on a constant-velocity ramp, in milliseconds. */
static double ramp_lag_ms(double fmin, double beta, double v) {
    OneEuro f;
    oneeuro_init(&f, fmin, beta, D_CUTOFF);
    double t = 0.0, x = 0.0, out = 0.0;
    int n = (int)(6.0 / DT);          /* 6 s: long past settling at every setting */
    for (int i = 0; i < n; i++) {
        out = oneeuro_filter(&f, x, t);
        x += v * DT;
        t += DT;
    }
    double lag_px = (x - v * DT) - out;   /* x has already advanced one step */
    return 1000.0 * lag_px / v;
}

/* 10-90% rise time on a unit position step, in milliseconds. */
static double step_rise_ms(double fmin, double beta) {
    OneEuro f;
    oneeuro_init(&f, fmin, beta, D_CUTOFF);
    double t = 0.0;
    oneeuro_filter(&f, 0.0, t); t += DT;          /* prime at 0 */
    for (int i = 0; i < 20; i++) { oneeuro_filter(&f, 0.0, t); t += DT; }
    double t10 = -1.0, t90 = -1.0, t0 = t;
    int n = (int)(10.0 / DT);
    for (int i = 0; i < n; i++) {
        double y = oneeuro_filter(&f, 1.0, t);
        if (t10 < 0.0 && y >= 0.10) t10 = t;
        if (t90 < 0.0 && y >= 0.90) { t90 = t; break; }
        t += DT;
    }
    if (t90 < 0.0) return -1.0;                   /* never got there */
    (void)t0;
    return 1000.0 * (t90 - t10);
}

/* Lag on a real trace, from the SPATIAL error and the pen's own speed.
 *
 * Cross-correlation was tried first and is the wrong instrument here: the
 * dataset samples at 111 Hz, so a 20 ms lag is barely two samples, while the
 * signal is dominated by the spiral's multi-second shape. The correlation peak
 * is far too broad to resolve two samples and simply reported 0.0 ms for every
 * setting, which is obviously false.
 *
 * How far the ink sits behind the pen in PIXELS is directly measurable and is
 * the same quantity VALIDATION.md quotes. Dividing by the pen's mean speed
 * converts it to milliseconds. */
static void real_lag(const double *x, const double *y, const double *fx, const double *fy,
                     const double *t_ms, int n, double *lag_px, double *speed, double *lag_ms) {
    double sd = 0.0, sp = 0.0;
    for (int i = 0; i < n; i++) sd += hypot(x[i] - fx[i], y[i] - fy[i]);
    for (int i = 1; i < n; i++) sp += hypot(x[i] - x[i-1], y[i] - y[i-1]);
    *lag_px = sd / n;
    *speed  = sp / ((t_ms[n-1] - t_ms[0]) / 1000.0);
    *lag_ms = (*speed > 0.0) ? 1000.0 * (*lag_px) / (*speed) : 0.0;
}

int main(int argc, char **argv) {
    printf("Tracey added-latency measurement\n");
    printf("sample interval %.1f ms (%.0f Hz), measured on the XP-Pen\n\n", DT * 1000.0, 1.0 / DT);

    printf("Steady-state lag added by the filter, milliseconds:\n\n");
    printf("  %-26s", "pen speed (px/s) ->");
    for (int s = 0; s < NSPEED; s++) printf("%9.0f", SPEEDS[s]);
    printf("\n");
    for (int i = 0; i < NSET; i++) {
        printf("  %-26s", SETTINGS[i].name);
        for (int s = 0; s < NSPEED; s++)
            printf("%9.1f", ramp_lag_ms(SETTINGS[i].fmin, SETTINGS[i].beta, SPEEDS[s]));
        printf("\n");
    }

    printf("\n10-90%% rise on a position step, milliseconds (a hard direction change):\n\n");
    for (int i = 0; i < NSET; i++)
        printf("  %-26s %8.1f\n", SETTINGS[i].name, step_rise_ms(SETTINGS[i].fmin, SETTINGS[i].beta));

    if (argc > 1) {
        FILE *fp = fopen(argv[1], "r");
        if (!fp) { printf("\ncould not open %s\n", argv[1]); return 1; }
        static double xs[200000], ys[200000], ts[200000];
        int n = 0;
        while (n < 200000 && fscanf(fp, "%lf %lf %lf", &xs[n], &ys[n], &ts[n]) == 3) n++;
        fclose(fp);
        if (n < 100) { printf("\n%s: only %d samples, skipping\n", argv[1], n); return 1; }

        double dur = (ts[n-1] - ts[0]) / 1000.0;
        double fs = (n - 1) / dur;
        double plen = 0.0;
        for (int i = 1; i < n; i++) plen += hypot(xs[i]-xs[i-1], ys[i]-ys[i-1]);
        printf("\nReal Parkinson's trace: %s\n", argv[1]);
        printf("  %d samples, %.1f s, %.0f Hz, mean pen speed %.0f px/s\n\n", n, dur, fs, plen / dur);

        static double fx[200000], fy[200000];
        printf("  %-26s %10s %10s\n", "setting", "lag (px)", "lag (ms)");
        for (int i = 0; i < NSET; i++) {
            OneEuro f, g;
            oneeuro_init(&f, SETTINGS[i].fmin, SETTINGS[i].beta, D_CUTOFF);
            oneeuro_init(&g, SETTINGS[i].fmin, SETTINGS[i].beta, D_CUTOFF);
            for (int k = 0; k < n; k++) {
                fx[k] = oneeuro_filter(&f, xs[k], ts[k] / 1000.0);
                fy[k] = oneeuro_filter(&g, ys[k], ts[k] / 1000.0);
            }
            double lpx, spd, lms;
            real_lag(xs, ys, fx, fy, ts, n, &lpx, &spd, &lms);
            printf("  %-26s %10.2f %10.1f\n", SETTINGS[i].name, lpx, lms);
        }
    }
    return 0;
}
