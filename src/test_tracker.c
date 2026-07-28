/* test_tracker.c - validate the tremor tracker with synthetic signals.
 * No tablet / no tremor user needed: inject a known sinusoid, confirm the
 * tracker recovers its frequency; inject pure intended motion, confirm it
 * reports "no tremor".
 *
 * Build: cl /nologo /O2 test_tracker.c /Fe:test_tracker.exe   (or: cc -O2 ...)
 */
#include <stdio.h>
#include <math.h>
#include "common/tremor_tracker.h"

static unsigned long g_seed = 12345;
static double noise(void) {                    /* deterministic +-0.5 */
    g_seed = g_seed * 1103515245u + 12345u;
    return ((double)((g_seed >> 8) & 0xFFFFFF) / 16777216.0) - 0.5;
}

/* Simulate ~2.7 s of drawing at 150 Hz: slow intended motion + optional tremor. */
static void run_case(double tremor_hz, double amp, double noise_amp,
                     double *out_freq, double *out_strength) {
    TremorTracker t; tt_init(&t);
    const double fs = 150.0, dt = 1.0 / fs;
    const int nsamp = 400;
    for (int i = 0; i < nsamp; i++) {
        double ts = i * dt;
        double ix = 500.0 + 80.0 * sin(2.0 * TT_PI * 0.3 * ts);   /* intended path */
        double iy = 400.0 + 60.0 * cos(2.0 * TT_PI * 0.25 * ts);
        double tx = (tremor_hz > 0) ? amp * sin(2.0 * TT_PI * tremor_hz * ts) : 0.0;
        double ty = (tremor_hz > 0) ? amp * cos(2.0 * TT_PI * tremor_hz * ts) : 0.0;
        tt_push(&t, ix + tx + noise_amp * noise(), iy + ty + noise_amp * noise(), ts);
    }
    tt_analyze(&t);
    *out_freq = t.freq_hz; *out_strength = t.strength;
}

/* Quantify what a PEN LIFT during calibration costs the estimate.
 *
 * calib_sample() only pushes samples while the pen is INCONTACT, so a lift is
 * invisible to the tracker as an event — but the pen comes back down somewhere
 * else, and that appears in the position buffer as a step discontinuity.
 *
 * `tt_push` already refuses any dt >= 0.1 s for the mean-dt estimate, so the
 * idle gap does NOT corrupt fs. That guard does nothing for the buffer itself:
 * `bx[head] = x` is unconditional, so the jump lands in the FFT window, where a
 * step is broadband and competes with the tremor peak. This measures the damage
 * to the reported frequency, and prints fs so the guard is visible as working.
 *
 * lift_at < 0 means "no lift" — the baseline this is compared against. */
static void run_lift_case(double fs, double tremor_hz, double amp,
                          double jump_px, int lift_at,
                          double *out_freq, double *out_strength, double *out_fs)
{
    TremorTracker t; tt_init(&t);
    const double dt = 1.0 / fs;
    double ts = 0.0, offx = 0.0, offy = 0.0;
    for (int i = 0; i < 400; i++) {
        if (lift_at >= 0 && i == lift_at) {
            ts    += 0.40;                 /* 400 ms with the pen off the tablet */
            offx  += jump_px;              /* set back down somewhere else */
            offy  += jump_px * 0.6;
        }
        double ix = 500.0 + 80.0 * sin(2.0 * TT_PI * 0.3 * ts) + offx;
        double iy = 400.0 + 60.0 * cos(2.0 * TT_PI * 0.25 * ts) + offy;
        double tx = amp * sin(2.0 * TT_PI * tremor_hz * ts);
        double ty = amp * cos(2.0 * TT_PI * tremor_hz * ts);
        tt_push(&t, ix + tx, iy + ty, ts);
        ts += dt;
    }
    tt_analyze(&t);
    *out_freq = t.freq_hz;
    *out_strength = t.strength;
    *out_fs = (t.dt_n > 0) ? (double)t.dt_n / t.dt_acc : 0.0;
}

/* Regression: whatever the signal, a NON-ZERO estimate must lie inside the
 * search band. A real 10 s calibration at ~200 Hz reported tremor_hz = 1.56
 * from a band floored at 3.0 Hz — impossible by construction, so the peak
 * refinement was escaping the band. Large sub-band drift with little or no
 * in-band tremor is exactly the Parkinson's case, and exactly what triggers it. */
static double run_drift_case(double fs, double drift_hz, double drift_amp,
                             double tremor_hz, double tremor_amp) {
    TremorTracker t; tt_init(&t);
    const double dt = 1.0 / fs;
    for (int i = 0; i < 600; i++) {
        double ts = i * dt;
        double dx = drift_amp * sin(2.0 * TT_PI * drift_hz * ts);
        double dy = drift_amp * cos(2.0 * TT_PI * drift_hz * ts);
        double tx = (tremor_amp > 0) ? tremor_amp * sin(2.0 * TT_PI * tremor_hz * ts) : 0.0;
        double ty = (tremor_amp > 0) ? tremor_amp * cos(2.0 * TT_PI * tremor_hz * ts) : 0.0;
        tt_push(&t, 500.0 + dx + tx + 0.2 * noise(), 400.0 + dy + ty + 0.2 * noise(), ts);
    }
    tt_analyze(&t);
    return t.freq_hz;
}

int main(void) {
    int fails = 0;
    struct { const char *name; double tremor, amp, noise, expect; int want_peak; } cases[] = {
        { "5 Hz tremor",  5.0, 6.0, 0.3, 5.0, 1 },
        { "6 Hz tremor",  6.0, 6.0, 0.3, 6.0, 1 },
        { "9 Hz tremor",  9.0, 4.0, 0.3, 9.0, 1 },
        { "no tremor",    0.0, 0.0, 0.3, 0.0, 0 },
    };
    for (int i = 0; i < 4; i++) {
        double f, s;
        run_case(cases[i].tremor, cases[i].amp, cases[i].noise, &f, &s);
        int ok;
        if (cases[i].want_peak) ok = (fabs(f - cases[i].expect) <= 1.5) && (f > 0.0);
        else                    ok = (f == 0.0);
        printf("%-14s -> freq=%.2f Hz strength=%.2f  [%s]\n",
               cases[i].name, f, s, ok ? "PASS" : "FAIL");
        if (!ok) fails++;
    }
    printf("\nband invariant: a non-zero estimate must be inside %.0f-%.0f Hz\n",
           TT_FMIN_HZ, TT_FMAX_HZ);
    {
        const double rates[]  = { 120.0, 150.0, 180.0, 200.0, 240.0 };
        const double drifts[] = { 0.8, 1.2, 1.8, 2.5 };
        const double trem[]   = { 0.0, 4.0, 7.0 };
        int checked = 0, out = 0;
        for (int r = 0; r < 5; r++)
        for (int d = 0; d < 4; d++)
        for (int m = 0; m < 3; m++) {
            double amp = (trem[m] > 0) ? 2.0 : 0.0;      /* tremor small vs drift */
            double f = run_drift_case(rates[r], drifts[d], 40.0, trem[m], amp);
            checked++;
            if (f != 0.0 && (f < TT_FMIN_HZ - 1e-6 || f > TT_FMAX_HZ + 1e-6)) {
                if (out < 6) printf("  OUT OF BAND: fs=%.0f drift=%.1fHz tremor=%.1fHz -> %.2f Hz\n",
                                    rates[r], drifts[d], trem[m], f);
                out++;
            }
        }
        printf("  %d combinations, %d out of band  [%s]\n", checked, out, out ? "FAIL" : "PASS");
        if (out) fails++;
    }

    printf("\npen lift during calibration (6.0 Hz tremor, amp 6.0, fs 150):\n");
    printf("  the dt>=0.1s guard should keep fs intact; the position STEP is the damage\n");
    {
        double f0, s0, fs0;
        run_lift_case(150.0, 6.0, 6.0, 0.0, -1, &f0, &s0, &fs0);
        printf("  %-22s freq=%6.2f Hz  strength=%.3f  fs=%.2f\n", "no lift (baseline)", f0, s0, fs0);
        const double jumps[] = { 20.0, 60.0, 150.0, 400.0 };
        for (int j = 0; j < 4; j++) {
            double f, s, fsx;
            /* 340, not 200: the buffer holds only the last TT_N=128 samples, so
               of 400 pushed only 272..399 are analysed. A lift at 200 is never
               in the window and measures nothing — it read as "harmless". */
            run_lift_case(150.0, 6.0, 6.0, jumps[j], 340, &f, &s, &fsx);
            printf("  lift, jump %5.0f px    freq=%6.2f Hz  strength=%.3f  fs=%.2f   err=%+.2f Hz%s\n",
                   jumps[j], f, s, fsx, f - f0, (f == 0.0) ? "  (NO PEAK)" : "");
        }
    }

    /* FALSE POSITIVES on a steady hand.
     *
     * Real calibrations from a steady hand kept returning 3.4-4.1 Hz — all just
     * above the 3.0 Hz band floor, which is what leakage looks like, not tremor.
     * At the tablet's ~200 Hz the FFT bin spacing is fs/N = 200/128 = 1.56 Hz, so
     * the lowest in-band bin IS 3.13 Hz: any drawing motion big enough puts its
     * low-frequency shoulder straight into it. Detrending only removes a LINEAR
     * ramp; a curved scribble leaves plenty behind.
     *
     * This sweeps realistic scribble sizes with NO tremor at all and prints what
     * the tracker claims. Anything non-zero here is a false positive. */
    printf("\nsteady hand, NO tremor — what does it report? (bin spacing fs/128)\n");
    {
        const double rates[] = { 150.0, 200.0 };
        for (int r = 0; r < 2; r++) {
            printf("  fs=%.0f Hz  (bin spacing %.2f Hz, lowest in-band bin %.2f Hz)\n",
                   rates[r], rates[r] / TT_N, ceil(TT_FMIN_HZ * TT_N / rates[r]) * rates[r] / TT_N);
            const double dhz[] = { 0.3, 0.8, 1.5, 2.5 };
            const double damp[] = { 20.0, 60.0, 120.0 };
            for (int a = 0; a < 3; a++) {
                printf("    amp %3.0f px: ", damp[a]);
                for (int d = 0; d < 4; d++) {
                    double f = run_drift_case(rates[r], dhz[d], damp[a], 0.0, 0.0);
                    printf("%4.1fHz->%s%-6.2f ", dhz[d], f > 0 ? "" : " ", f);
                }
                printf("\n");
            }
        }
        printf("  (0.00 = correctly reports no tremor; anything else is a false positive)\n");
    }

    /* The cost of the floor guard, stated honestly: it rejects a peak sitting on
     * the band floor when the drift bin below is bigger — and a GENUINE tremor
     * near 3 Hz looks exactly like that. At fs=200 the bins are 3.12 and 4.69 Hz,
     * so anything under ~4 Hz has nowhere of its own to land. This prints where
     * detection actually starts, rather than assuming the guard is free. */
    printf("\nlow-tremor sensitivity — what the floor guard costs (fs=200, drift 1.5 Hz):\n");
    {
        const double tr[] = { 3.2, 3.5, 4.0, 4.5, 5.5, 7.0 };
        const double damp[] = { 10.0, 40.0 };
        for (int a = 0; a < 2; a++) {
            printf("  drift amp %3.0f px: ", damp[a]);
            for (int i = 0; i < 6; i++) {
                double f = run_drift_case(200.0, 1.5, damp[a], tr[i], 6.0);
                printf("%.1f->%s%-5.2f ", tr[i], f > 0 ? "" : " ", f);
            }
            printf("\n");
        }
        printf("  (0.00 = tremor present but NOT reported)\n");
    }

    printf("\nadaptive fmin mapping (baseline 0.40):\n");
    TremorTracker t; tt_init(&t);
    t.freq_hz = 6.0;  printf("  tremor 6 Hz -> fmin %.2f\n", tt_adaptive_fmin(&t, 0.40));
    t.freq_hz = 10.0; printf("  tremor 10 Hz -> fmin %.2f\n", tt_adaptive_fmin(&t, 0.40));
    t.freq_hz = 0.0;  printf("  no tremor    -> fmin %.2f (baseline)\n", tt_adaptive_fmin(&t, 0.40));

    printf("\n%s (%d failures)\n", fails ? "SOME TESTS FAILED" : "ALL TESTS PASSED", fails);
    return fails ? 1 : 0;
}
