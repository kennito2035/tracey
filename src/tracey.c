/* tracey.c - tremor-compensating pen filter (native uiAccess core).
 *
 * Pipeline: capture pen via RegisterPointerInputTarget(PT_PEN) -> one-euro
 * filter on X/Y -> re-inject a synthetic pen at the smoothed position with
 * InjectSyntheticPointerInput. RPIT redirects the raw pen away from the target
 * app, so the app only sees the filtered stroke. Works in any pen/Ink app.
 *
 * Must run as a signed uiAccess exe from a secure path (Program Files); a
 * uiAccess Python process dies in the loader, which is why this is native C.
 *
 * Modes (launch arg; env vars do not survive the UAC/AppInfo boundary):
 *   (default)     filter mode. Loads profile.cfg if present, else Balanced.
 *                 Ctrl+Alt+1..3 change smoothing live; Ctrl+Alt+Q stops this core.
 *                 A running core also calibrates IN-PROCESS on config.cfg
 *                 calibrate=1 -- see below; that is how the UI does it.
 *   --calibrate   measure action tremor for 10 s and save a smoothing profile,
 *                 then exit. Standalone/CLI use only.
 *   --debug       popups + verbose per-sample logging.
 *   --no-prompt   suppress the calibration dialogs (the UI wizard shows its own).
 *   --notch       (experimental) add a tracker-driven adaptive notch that removes
 *                 the dominant tremor frequency before the one-euro smoother. It
 *                 suppresses rhythmic tremor far more than the low-pass alone,
 *                 regardless of stroke speed. No-op on a steady hand.
 */
#define WINVER       0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <math.h>
#include "common/oneeuro.h"
#include "common/tremor_tracker.h"   /* v3: FFT tremor-frequency estimate for calibration */
#include "common/notch.h"            /* v3: optional adaptive tremor notch (--notch) */

#define SYNTH_ID       1u   /* pointerId stamped on injected pen input */
#define MODE_FILTER    0
#define MODE_CALIBRATE 1
#define CAL_TIMER_ID   2
#define POLL_TIMER_ID  3    /* polls config.cfg for live UI control */
#define HB_TIMER_ID    4    /* 1 Hz status.cfg heartbeat (liveness for the UI) */
#define CAL_SECONDS    10
#define NOTCH_Q        4.0  /* --notch band quality; bandwidth = f/Q */

#ifndef DIAG_OFFSET_X       /* diagnostic-only shift of the injected stroke */
#define DIAG_OFFSET_X 0
#endif

static int                      g_debug = 0;
static int                      g_mode  = MODE_FILTER;
static int                      g_noprompt = 0;  /* --no-prompt: UI drives calibration */
static FILE                    *g_log = NULL;
static HSYNTHETICPOINTERDEVICE  g_dev = NULL;
static LARGE_INTEGER            g_qpf;
static OneEuro                  g_fx, g_fy;

/* --notch (opt-in, experimental): a tracker-driven adaptive notch that removes
 * the dominant tremor frequency ahead of the one-euro smoother. Off by default;
 * the validated one-euro path is untouched unless --notch is passed. */
static int      g_notch_on    = 0;
static Notch    g_nx, g_ny;
static int      g_notch_ready = 0;   /* set once the notch has a frequency to target */
static unsigned g_notch_ctr   = 0;
static double   g_notch_seed_hz = 0.0;  /* calibrated tremor freq (from profile.cfg) */

static unsigned g_real = 0, g_injOk = 0, g_injFail = 0, g_sentinel = 0;
static unsigned g_hover = 0;   /* hover re-injections; not stroke samples, so kept
                                * out of g_real or the log reads as if we drew more
                                * than the pen actually reported. */

/* Latency telemetry (why the busy cursor appears): time inside the inject call,
 * and the gap between consecutive pen events we handle. A large gap with a small
 * inject time means something else is stalling the message loop. */
static double   g_injUs_total = 0.0, g_injUs_max = 0.0;
static unsigned g_injN = 0;
static double   g_gapMs_max = 0.0, g_gapMs_total = 0.0;
static unsigned g_gapN = 0;
static double   g_lastPenT = 0.0;

/* raw-vs-filtered smoothing telemetry */
static double   g_rawlen = 0.0, g_filtlen = 0.0, g_maxdev = 0.0;
static int      g_prawx, g_prawy, g_pfx, g_pfy, g_haveprev = 0;
static unsigned g_statn = 0;

/* calibration accumulators (mean deviation of raw from a smoothed reference) */
static unsigned g_cal_count = 0;
static double   g_cal_steplen = 0.0;
static int      g_cal_have = 0;
static int      g_cal_contact = 0;      /* pen currently touching, for lift detection */
static unsigned g_cal_an = 0;           /* re-analyse counter during calibration */

/* A tremor frequency is reported only if it PERSISTS across the run.
 *
 * This replaced "keep the strongest peak seen", which sounded robust and was the
 * opposite. Evaluated over the deduplicated Isenkul/Sakar set (61 PD + 15
 * control) with analyze_tremor_detect.py: only 1.4% of control windows (3.7% PD)
 * produce any peak at all, so picking the strongest single window is a "find me
 * the flukiest window" operator. It latches a frequency on 11/15 controls, and on
 * the dev tablet a steady hand got 3.5, then 4, then 10 Hz on consecutive runs.
 *
 * The peak strength carries no usable PD/control signal as shipped: AUC 0.36–0.40
 * raw (0.5 is chance, and BELOW 0.5 means the controls actually scored higher). A
 * 2.5 Hz high-pass ahead of the FFT does lift it to 0.61–0.74 — the detector is
 * not hopeless, it is unbuilt — but that rests on 15 controls in an offline spiral
 * task and has never been tried on the live calibration scribble, so nothing here
 * relies on it (v3+ work). The honest output for almost every hand is therefore
 * "no frequency". Requiring the peak in a tenth of the windows and taking the
 * MEDIAN of those gives exactly that (0/15 controls on that set), and still
 * reports a real, sustained rhythmic tremor if one is there. Calibration's
 * amplitude path (g_cal_steplen -> preset) is unaffected and is what actually
 * sets the smoothing. */
#define CAL_HZ_MAX      512
#define CAL_HZ_MIN_PCT  10      /* peak must appear in >= this % of windows */
static double   g_cal_hz_buf[CAL_HZ_MAX];
static int      g_cal_hz_n = 0;
static unsigned g_cal_win = 0;
static void     cal_window(void);        /* defined after calib_sample, used by it */
static double   cal_tremor_hz(void);

/* Smoothing presets: lower fmin = more smoothing at rest; higher beta keeps
 * fast intentional motion responsive. Ctrl+Alt+1..3 select these live.
 *
 * These are EXACTLY the UI's three cards (ui/electron/core-comms.js PRESETS) and
 * must stay that way. There used to be a five-step scale here that shared only
 * its middle entry with the UI, so four of the five hotkeys put the core on
 * values no card could represent and the UI showed no selection at all. Worse,
 * the old "5 heavy" raised beta to 0.080, which makes the filter yield to motion
 * FASTER: measured across 61 patients it removed 6.9% of the 4-8 Hz band against
 * Steadiest's 19.0%, so the strongest-looking hotkey was the weakest setting.
 * Index i is published as preset=i+1, which is the UI's card id, and -1 -> 0 is
 * the id the UI reserves for "custom". */
typedef struct { double fmin, beta; } Preset;
static const Preset PRESETS[3] = {
    {0.70, 0.050},   /* 1 Gentle */
    {0.40, 0.020},   /* 2 Balanced (default) */
    {0.22, 0.010},   /* 3 Steadiest */
};
static int    g_preset   = 1;      /* index; -1 means calibrated/custom (profile or UI) */
static double g_dcut     = 1.0;
static double g_cur_fmin = 0.40, g_cur_beta = 0.020;

/* UI control channel + calibration tracker */
static int           g_enabled    = 1;    /* on/off, driven by config.cfg */
static int           g_registered = 0;    /* is RPIT currently active */
static HWND          g_hwnd       = NULL;
static TremorTracker g_trk;               /* used in calibrate mode */
static ULONGLONG     g_cfg_mtime  = 0;    /* config.cfg last-write, for change detection */

/* In-process calibration (config.cfg calibrate=1), so the UI never has to stop
 * and relaunch this process. Each launch of a uiAccess exe costs a UAC prompt,
 * so the old stop -> --calibrate -> relaunch sequence charged the user TWO
 * prompts just to measure their tremor. Calibrating inside the running core
 * costs none. --calibrate still works standalone for CLI use. */
static int    g_calibrating       = 0;    /* a live calibration is in progress */
static int    g_cal_saved_enabled = 1;    /* pause state to restore afterwards */
/* Result of the most recent calibration attempt: 0 = none yet, or it failed.
 * LATCHED rather than reported through tremor_hz, because the 1 Hz heartbeat
 * republishes tremor_hz constantly and would race the UI's read of a failure. */
static double g_cal_hz            = 0.0;

static void LOGF(const char *fmt, ...);

static void tt_dir(wchar_t *out) {
    const wchar_t *pd = _wgetenv(L"ProgramData");
    if (!pd) pd = L"C:\\ProgramData";
    wsprintfW(out, L"%s\\Tracey", pd);
}
static void tt_file(wchar_t *out, const wchar_t *leaf) {
    wchar_t dir[MAX_PATH]; tt_dir(dir);
    wsprintfW(out, L"%s\\%s", dir, leaf);
}

/* ---- calibration path (for the wizard to draw) ----------------------------
 * The UI cannot obtain this by itself. The core has the pen captured by RPIT, so
 * no pointer events reach the wizard's canvas, and sampling the SYSTEM CURSOR
 * instead picks up the touchpad exactly as readily as the tablet - with the
 * tablet unplugged it drew the touchpad. Only the core knows which samples
 * genuinely came from the pen, so the core publishes the path.
 *
 * Written as plain text next to the other control files: a bounds header (the
 * virtual desktop, in the core's own physical pixels - it is PerMonitorV2 aware
 * and the UI's DIP coordinates would disagree at non-100% scaling) followed by
 * one "x y" per point. Every 4th sample is kept and the file is rewritten a few
 * times a second: this is a drawing aid, not the measurement. */
#define CALPATH_MAX 1024
/* Sentinel x meaning "the pen came off the tablet here". The path was a flat
 * point list with no stroke boundaries, so the wizard drew one continuous
 * polyline and joined the end of one stroke to the start of the next with a
 * straight line the user never drew. Written to calpath.cfg as a lone "-". */
#define CP_BREAK (-1000000)
static int      g_cp_x[CALPATH_MAX], g_cp_y[CALPATH_MAX];
static int      g_cp_n = 0;
static unsigned g_cp_seq = 0;
static int      g_vx = 0, g_vy = 0, g_vw = 0, g_vh = 0;   /* virtual desktop */

/* Temp file + atomic replace, NOT a plain truncate-and-rewrite. The UI reads
 * this several times a second while we rewrite it several times a second; a
 * direct rewrite hands it a half-written file, and a path that is randomly
 * truncated on each read looks exactly like a stuttering, lagging line. */
static void calpath_write(void) {
    wchar_t path[MAX_PATH], tmp[MAX_PATH];
    tt_file(path, L"calpath.cfg");
    tt_file(tmp,  L"calpath.tmp");
    FILE *f = _wfopen(tmp, L"w");
    if (!f) return;
    fprintf(f, "bounds=%d %d %d %d\n", g_vx, g_vy, g_vw, g_vh);
    for (int i = 0; i < g_cp_n; i++) {
        if (g_cp_x[i] == CP_BREAK) fprintf(f, "-\n");
        else                       fprintf(f, "%d %d\n", g_cp_x[i], g_cp_y[i]);
    }
    fclose(f);
    MoveFileExW(tmp, path, MOVEFILE_REPLACE_EXISTING);
}

static unsigned g_cp_mask = 1u;      /* keep 1 sample in (mask+1) */

static void calpath_reset(void) {
    g_cp_n = 0; g_cp_seq = 0; g_cp_mask = 1u;
    calpath_write();                 /* truncate, so the UI never sees a stale path */
}

/* Rates chosen for a line that keeps up with the hand: keep every 2nd sample
 * (~100 Hz of a ~200 Hz stream) and republish every 8th (~25 Hz). The first
 * cut of this kept every 4th and published every 32nd - ~6 Hz - which, on top
 * of the UI's own poll, put the drawn line visibly behind the pen.
 *
 * When the buffer fills, HALVE it and halve the sampling rate rather than
 * dropping the tail. At 200 Hz, 10 s of every-2nd-sample is ~1000 points
 * against a 1024 cap -- so a slightly faster pen, or a longer CAL_SECONDS,
 * would have hit the ceiling and the line would simply stop growing while the
 * user was still drawing. Decimating keeps the WHOLE stroke on screen at lower
 * resolution, which is all the pad is for; the measurement is untouched by any
 * of this. */
static void calpath_push(int x, int y) {
    unsigned k = g_cp_seq++;
    if ((k & g_cp_mask) != 0u) return;
    if (g_cp_n >= CALPATH_MAX) {
        int half = CALPATH_MAX / 2;
        for (int i = 0; i < half; i++) {
            /* Keeping every other point would DROP a break that happens to sit on
             * an odd index, silently re-joining two strokes. A break survives if
             * either of the two points it stands between is one. */
            if (g_cp_x[i * 2] == CP_BREAK || g_cp_x[i * 2 + 1] == CP_BREAK) {
                g_cp_x[i] = CP_BREAK; g_cp_y[i] = CP_BREAK;
            } else {
                g_cp_x[i] = g_cp_x[i * 2]; g_cp_y[i] = g_cp_y[i * 2];
            }
        }
        g_cp_n = half;
        g_cp_mask = (g_cp_mask << 1) | 1u;
    }
    g_cp_x[g_cp_n] = x; g_cp_y[g_cp_n] = y; g_cp_n++;
    if ((k & 7u) == 0u) calpath_write();
}

/* Mark a pen-up. No leading break, and never two in a row — both would just be
 * empty segments for the wizard to skip. */
static void calpath_break(void) {
    if (g_cp_n <= 0 || g_cp_n >= CALPATH_MAX) return;
    if (g_cp_x[g_cp_n - 1] == CP_BREAK) return;
    g_cp_x[g_cp_n] = CP_BREAK; g_cp_y[g_cp_n] = CP_BREAK; g_cp_n++;
    calpath_write();
}

/* ---- pen-tablet presence -------------------------------------------------
 * Is a pen digitizer PHYSICALLY attached?
 *
 * The two obvious APIs both lie, measured on the dev machine with the tablet
 * unplugged: GetSystemMetrics(SM_DIGITIZER) still returns EXTERNAL_PEN|READY
 * (it is sticky - it says what the machine supports, not what is plugged in),
 * and raw-input enumeration still lists a digitizer because the tablet driver
 * keeps VIRTUAL HID nodes alive with no hardware behind them
 * (HID\PENTABLET&COL03 under ROOT\HIDCLASS, present either way).
 *
 * What separates them is where the node hangs: a real pen is enumerated on a
 * real bus (USB\, I2C\, ACPI\, BTHENUM\), a driver's node on ROOT\. So: a
 * present HID node whose hardware IDs carry a digitizer/pen usage
 * (UP:000D_U:0001 or _U:0002) and whose parent is not ROOT\.
 *
 * This lives in the core because the UI's equivalent cost ~3.3 s of PowerShell
 * per check, which forced a 20 s poll and up to 24 s to notice an unplug. Here
 * it is a few milliseconds, so it runs on the 1 Hz heartbeat and the UI just
 * reads `pen` out of status.cfg. */
static int g_pen_present = -1;   /* -1 = not probed yet */

static int detect_pen(void) {
    HDEVINFO h = SetupDiGetClassDevsW(NULL, L"HID", NULL, DIGCF_PRESENT | DIGCF_ALLCLASSES);
    if (h == INVALID_HANDLE_VALUE) return -1;              /* unknown, not "absent" */
    int found = 0;
    SP_DEVINFO_DATA did; did.cbSize = sizeof(did);
    for (DWORD i = 0; !found && SetupDiEnumDeviceInfo(h, i, &did); i++) {
        wchar_t ids[2048];
        if (!SetupDiGetDeviceRegistryPropertyW(h, &did, SPDRP_HARDWAREID, NULL,
                                               (PBYTE)ids, sizeof(ids), NULL)) continue;
        int digitizer = 0;
        for (wchar_t *p = ids; *p; p += wcslen(p) + 1)      /* REG_MULTI_SZ */
            if (wcsstr(p, L"UP:000D_U:0001") || wcsstr(p, L"UP:000D_U:0002")) { digitizer = 1; break; }
        if (!digitizer) continue;
        DEVINST parent;
        if (CM_Get_Parent(&parent, did.DevInst, 0) != CR_SUCCESS) continue;
        wchar_t pid[MAX_DEVICE_ID_LEN];
        if (CM_Get_Device_IDW(parent, pid, MAX_DEVICE_ID_LEN, 0) != CR_SUCCESS) continue;
        if (_wcsnicmp(pid, L"ROOT\\", 5) != 0) found = 1;   /* real bus => real pen */
    }
    SetupDiDestroyDeviceInfoList(h);
    return found;
}

/* Temp file + atomic replace. The UI reads profile.cfg on every state push to
 * decide whether the "Custom" card is selectable, so a truncate-and-rewrite let
 * it catch the file empty for an instant and the card flickered enabled/
 * disabled at the end of every calibration. */
static void save_profile(double fmin, double beta, int preset, double tremor_hz) {
    wchar_t dir[MAX_PATH], path[MAX_PATH], tmp[MAX_PATH];
    tt_dir(dir); CreateDirectoryW(dir, NULL);
    tt_file(path, L"profile.cfg");
    tt_file(tmp,  L"profile.tmp");
    FILE *f = _wfopen(tmp, L"w");
    if (!f) return;
    fprintf(f, "fmin=%.4f\nbeta=%.5f\npreset=%d\ntremor_hz=%.2f\n",
            fmin, beta, preset, tremor_hz);
    fclose(f);
    MoveFileExW(tmp, path, MOVEFILE_REPLACE_EXISTING);
}
/* tremor_hz is optional (0 if absent); it seeds the --notch center frequency. */
static int load_profile(double *fmin, double *beta, double *tremor_hz) {
    wchar_t path[MAX_PATH]; tt_file(path, L"profile.cfg");
    FILE *f = _wfopen(path, L"r");
    if (!f) return 0;
    double fm = -1.0, be = -1.0, hz = 0.0, v; char line[128];
    while (fgets(line, sizeof line, f)) {
        if      (sscanf(line, "fmin=%lf", &v) == 1)      fm = v;
        else if (sscanf(line, "beta=%lf", &v) == 1)      be = v;
        else if (sscanf(line, "tremor_hz=%lf", &v) == 1) hz = v;
    }
    fclose(f);
    if (fm > 0.0 && be >= 0.0) { *fmin = fm; *beta = be; if (tremor_hz) *tremor_hz = hz; return 1; }
    return 0;
}

/* ---- UI control channel (filesystem, crosses the UAC boundary) -------------
 * config.cfg is OWNED BY THE UI (non-elevated writes enabled/fmin/beta/quit); this
 * elevated core only READS it, detecting changes by last-write time. The core
 * writes status.cfg (running/enabled/params/tremor_hz) for the UI to read.
 * (The core must not write config.cfg or it becomes admin-owned and the
 * non-elevated UI can no longer overwrite it.) No IPC library needed.
 *
 * quit=1 is a ONE-SHOT stop command: a non-elevated UI cannot TerminateProcess
 * this elevated core, so that is its only clean way to stop us. It is never
 * sticky (absent => 0), so the UI must omit it on every normal write or the
 * next launch would exit immediately. enabled=0 is PAUSE (capture off, process
 * stays up); quit=1 exits. Ctrl+Alt+Q still works as the manual exit.
 */
static ULONGLONG cfg_mtime(void) {
    wchar_t path[MAX_PATH]; tt_file(path, L"config.cfg");
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &fad)) return 0;
    ULARGE_INTEGER u;
    u.LowPart  = fad.ftLastWriteTime.dwLowDateTime;
    u.HighPart = fad.ftLastWriteTime.dwHighDateTime;
    return u.QuadPart;
}
/* status.cfg is rewritten on every change AND once a second (HB_TIMER_ID), so
 * the UI can detect a CRASHED/KILLED core: a hard kill can't run our clean-exit
 * write_status(0,...), leaving a stale running=1 forever. The UI therefore treats
 * a status.cfg whose last-write time is older than ~3 s as "core not running".
 * `heartbeat` increments on every write as an explicit, mtime-independent signal. */
static unsigned g_heartbeat = 0;

static void write_status(int running, double tremor_hz) {
    wchar_t dir[MAX_PATH], path[MAX_PATH];
    tt_dir(dir); CreateDirectoryW(dir, NULL); tt_file(path, L"status.cfg");
    FILE *f = _wfopen(path, L"w");
    if (f) {
        fprintf(f, "running=%d\nenabled=%d\nfmin=%.4f\nbeta=%.5f\npreset=%d\n"
                   "tremor_hz=%.2f\ncalibrating=%d\ncal_hz=%.2f\ncal_samples=%u\n"
                   "pen=%d\nheartbeat=%u\n",
                running, g_enabled, g_cur_fmin, g_cur_beta, g_preset + 1,
                tremor_hz, g_calibrating, g_cal_hz, g_cal_count,
                g_pen_present, ++g_heartbeat);
        fclose(f);
    }
    /* Instrumentation for the tray liveness defect: the UI declares this core
     * dead when status.cfg's age passes 3000 ms, so any gap between
     * consecutive writes that approaches it is worth a log line. A stalled
     * heartbeat (for example a slow pen probe on the beat) shows up here as a
     * LATE write, which no "did every write happen" check would catch. */
    {
        static LARGE_INTEGER s_prev;
        LARGE_INTEGER now, fq;
        QueryPerformanceCounter(&now); QueryPerformanceFrequency(&fq);
        if (s_prev.QuadPart) {
            long ms = (long)((now.QuadPart - s_prev.QuadPart) * 1000 / fq.QuadPart);
            if (ms > 2500)
                LOGF("status: %ld ms between status.cfg writes (UI stale threshold 3000)\n", ms);
        }
        s_prev = now;
    }
}
static int read_config(int *en, double *fm, double *be, int *quit, int *calib) {
    wchar_t path[MAX_PATH]; tt_file(path, L"config.cfg");
    FILE *f = _wfopen(path, L"r");
    if (!f) return 0;
    int e = -1, q = 0, c = 0; double m = -1.0, b = -1.0, v; char line[128];
    while (fgets(line, sizeof line, f)) {
        if      (sscanf(line, "enabled=%d", &e) == 1) {}
        else if (sscanf(line, "fmin=%lf", &v) == 1) m = v;
        else if (sscanf(line, "beta=%lf", &v) == 1) b = v;
        else if (sscanf(line, "quit=%d", &q) == 1) {}
        else if (sscanf(line, "calibrate=%d", &c) == 1) {}
    }
    fclose(f);
    if (e >= 0) *en = e;
    if (m > 0.0) *fm = m;
    if (b >= 0.0) *be = b;
    if (quit)  *quit  = q;   /* one-shot: absent => 0, so it is never sticky */
    if (calib) *calib = c;   /* one-shot, same rule - the UI must clear it */
    return 1;
}

static void begin_inproc_calibration(void);
/* Called ~5x/sec: if the UI rewrote config.cfg since last check, apply the new
 * params/on-off live (no filter-state reset) and republish status. */
static void poll_config(void) {
    ULONGLONG m = cfg_mtime();
    if (m == 0 || m <= g_cfg_mtime) return;           /* no config, or unchanged */
    g_cfg_mtime = m;
    int en = g_enabled, quit = 0, calib = 0; double fm = g_cur_fmin, be = g_cur_beta;
    if (!read_config(&en, &fm, &be, &quit, &calib)) return;
    if (quit) {                        /* UI asked us to exit (it cannot kill an
                                        * elevated process itself) */
        LOGF("config: quit=1 -> exiting\n");
        PostQuitMessage(0);
        return;
    }
    if (calib && !g_calibrating) {     /* measure in-process; no relaunch, no UAC */
        begin_inproc_calibration();
        return;                        /* params are ours for the duration */
    }
    if (g_calibrating) return;         /* ignore slider traffic mid-measurement */
    int changed = 0;
    if (fm != g_cur_fmin || be != g_cur_beta) {
        g_cur_fmin = fm; g_cur_beta = be;
        g_fx.fmin = fm; g_fx.beta = be; g_fy.fmin = fm; g_fy.beta = be;  /* live, no reset */
        g_preset = -1;
        changed = 1;
    }
    if (en != g_enabled) {
        g_enabled = en; changed = 1;
        if (g_enabled && !g_registered) {
            if (RegisterPointerInputTarget(g_hwnd, PT_PEN)) g_registered = 1;
        } else if (!g_enabled && g_registered) {
            UnregisterPointerInputTarget(g_hwnd, PT_PEN); g_registered = 0;
        }
    }
    if (changed) { LOGF("config: enabled=%d fmin=%.3f beta=%.4f\n", g_enabled, g_cur_fmin, g_cur_beta); write_status(1, g_notch_seed_hz); }
}

static void LOGF(const char *fmt, ...) {
    if (!g_log) return;
    va_list ap; va_start(ap, fmt); vfprintf(g_log, fmt, ap); va_end(ap); fflush(g_log);
}

static double now_s(void) {
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return (double)c.QuadPart / (double)g_qpf.QuadPart;
}
static int iround(double v) { return (int)lround(v); }

static void stat_update(int rx, int ry, int fx, int fy) {
    double dev = hypot((double)(rx - fx), (double)(ry - fy));
    if (dev > g_maxdev) g_maxdev = dev;
    if (g_haveprev) {
        g_rawlen  += hypot((double)(rx - g_prawx), (double)(ry - g_prawy));
        g_filtlen += hypot((double)(fx - g_pfx),   (double)(fy - g_pfy));
    }
    g_prawx = rx; g_prawy = ry; g_pfx = fx; g_pfy = fy; g_haveprev = 1;
    unsigned n = g_statn++;
    if (g_debug && (n % 20) == 0) LOGF("  raw=(%d,%d) filt=(%d,%d) dev=%.1f\n", rx, ry, fx, fy, dev);
}

static void apply_preset(int i) {
    if (i < 0 || i > 2) return;
    g_preset = i;
    g_cur_fmin = PRESETS[i].fmin; g_cur_beta = PRESETS[i].beta;
    oneeuro_init(&g_fx, g_cur_fmin, g_cur_beta, g_dcut);
    oneeuro_init(&g_fy, g_cur_fmin, g_cur_beta, g_dcut);
    g_rawlen = g_filtlen = g_maxdev = 0.0; g_haveprev = 0; g_statn = 0;
    LOGF("preset %d fmin=%.2f beta=%.4f\n", i + 1, g_cur_fmin, g_cur_beta);
    write_status(1, g_notch_seed_hz);  /* status.cfg only, never config.cfg */
    for (int b = 0; b <= i; b++) { MessageBeep(MB_OK); Sleep(120); }
}

static void inject(int x, int y, POINTER_FLAGS flags, UINT32 pressure) {
    POINTER_TYPE_INFO pti;
    ZeroMemory(&pti, sizeof(pti));
    pti.type = PT_PEN;
    pti.penInfo.pointerInfo.pointerType       = PT_PEN;
    pti.penInfo.pointerInfo.pointerId         = SYNTH_ID;
    pti.penInfo.pointerInfo.pointerFlags      = flags;
    pti.penInfo.pointerInfo.ptPixelLocation.x = x;
    pti.penInfo.pointerInfo.ptPixelLocation.y = y;
    pti.penInfo.penMask  = PEN_MASK_PRESSURE;
    /* 0 pressure + INCONTACT is invalid, so clamp only while in contact; a hovering
     * pen must report 0 or it looks like it is touching the surface. */
    pti.penInfo.pressure = (flags & POINTER_FLAG_INCONTACT) ? (pressure ? pressure : 1) : 0;
    LARGE_INTEGER t0, t1; QueryPerformanceCounter(&t0);
    BOOL ok = InjectSyntheticPointerInput(g_dev, &pti, 1);
    QueryPerformanceCounter(&t1);
    /* Timing telemetry: if this call is slow it starves our message loop, and
     * Windows then paints the busy cursor while our window is the pen target. */
    double us = (double)(t1.QuadPart - t0.QuadPart) * 1e6 / (double)g_qpf.QuadPart;
    g_injUs_total += us; g_injN++;
    if (us > g_injUs_max) g_injUs_max = us;
    if (ok) g_injOk++;
    else { g_injFail++; LOGF("inject FAIL (%d,%d) err=%lu\n", x, y, GetLastError()); }
}

/* Calibration: while the user scribbles, measure action tremor as the mean
 * deviation between the raw path and a lightly-smoothed reference path. */
static void calib_sample(UINT32 id) {

    POINTER_PEN_INFO ppi;
    if (!GetPointerPenInfo(id, &ppi)) return;
    int x = ppi.pointerInfo.ptPixelLocation.x, y = ppi.pointerInfo.ptPixelLocation.y;

    /* Keep a live cursor while measuring. RPIT has already taken the raw pen away
     * from the system, so injecting nothing leaves NO pointer at all -- and
     * Windows then paints the busy/app-starting cursor over our overlay. Same
     * root cause as the old hover bug; it came back because calibration
     * deliberately does not inject a stroke.
     *
     * HOVER only, never INCONTACT: the cursor tracks the pen so the user can see
     * calibration is alive, but nothing is drawn into whatever app happens to be
     * underneath. Raw rather than smoothed - this is feedback, not output, and it
     * costs the measurement nothing either way. */
    if (g_dev) {
        inject(x, y, POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_PRIMARY, 0);
        g_hover++;
    }

    if (!(ppi.pointerInfo.pointerFlags & POINTER_FLAG_INCONTACT)) { g_cal_contact = 0; return; }

    /* PEN-DOWN after a lift. The pen comes back somewhere else, and that step is
     * poison to everything downstream if it is just fed in as the next sample:
     *
     *  - the reference smoother still holds the OLD position, so the first
     *    samples after re-contact yield a huge hypot(raw - smoothed) and inflate
     *    g_cal_steplen, which is what picks the preset;
     *  - the step lands in the tracker's FFT window, where it is broadband and
     *    buries the tremor peak. Measured in test_tracker.c: a lift inside the
     *    analysed window takes a clean 6 Hz signal from freq=5.93 strength=0.355
     *    to freq=0.00 strength=0.000 -- NO detection at all -- for jumps as small
     *    as 20px. (fs is fine: tt_push already refuses dt >= 0.1 s.)
     *
     * So: restart both, and mark the break for the wizard's line. g_cal_have=0
     * makes the first sample after re-contact seed the smoother instead of
     * scoring against it. */
    if (!g_cal_contact) {
        g_cal_contact = 1;
        if (g_cal_have) {                     /* a real lift, not the first touch */
            calpath_break();
            oneeuro_init(&g_fx, 0.7, 0.010, 1.0);
            oneeuro_init(&g_fy, 0.7, 0.010, 1.0);
            tt_init(&g_trk);
            g_cal_have = 0;
            LOGF("calibrate: pen lifted and replaced -- smoother and tracker restarted\n");
        }
    }

    calpath_push(x, y);          /* publish the scribble for the wizard to draw */
    double t = now_s();
    double sx = oneeuro_filter(&g_fx, x, t);
    double sy = oneeuro_filter(&g_fy, y, t);
    if (g_cal_have) { g_cal_steplen += hypot((double)x - sx, (double)y - sy); g_cal_count++; }
    g_cal_have = 1;
    tt_push(&g_trk, (double)x, (double)y, t);   /* v3 tracker: for the tremor-Hz readout */

    /* Latch the best estimate AS WE GO. The window is only the last TT_N samples,
     * so analysing solely at the end means a lift in the final ~0.85 s discards a
     * whole good scribble and reports "no shake measured". Re-analysing keeps the
     * strongest peak seen at any point during the run. */
    if ((++g_cal_an & 15u) == 0u) cal_window();
}

/* Analyse one window and record it. Split out so finish_calibration can count the
 * final window on exactly the same terms as every other one. */
static void cal_window(void) {
    g_cal_win++;
    tt_analyze(&g_trk);
    if (g_trk.freq_hz > 0.0 && g_cal_hz_n < CAL_HZ_MAX)
        g_cal_hz_buf[g_cal_hz_n++] = g_trk.freq_hz;
}

/* Median of the windows that found a peak, or 0 if too few of them did. */
static double cal_tremor_hz(void) {
    if (g_cal_win == 0) return 0.0;
    if ((long)g_cal_hz_n * 100 < (long)g_cal_win * CAL_HZ_MIN_PCT) return 0.0;
    for (int i = 1; i < g_cal_hz_n; i++) {       /* insertion sort; n is small */
        double v = g_cal_hz_buf[i];
        int j = i - 1;
        while (j >= 0 && g_cal_hz_buf[j] > v) { g_cal_hz_buf[j + 1] = g_cal_hz_buf[j]; j--; }
        g_cal_hz_buf[j + 1] = v;
    }
    return g_cal_hz_buf[g_cal_hz_n / 2];
}

/* --notch pre-filter: subtract the tremor band from both axes before the one-euro
 * smoother. The center frequency comes from the calibrated seed (measured during
 * --calibrate, where detection is reliable); it is refined to a live tracker peak
 * on the rare windows where one stands out above the intended motion. Dormant if
 * there is no seed and no live peak. Returns the notched position in *ox,*oy. */
static void notch_pre(int rx, int ry, double t, double *ox, double *oy) {
    *ox = rx; *oy = ry;
    if (!g_notch_on) return;
    tt_push(&g_trk, (double)rx, (double)ry, t);
    if ((++g_notch_ctr & 15u) == 0u && g_trk.dt_n >= 8) {
        double fs = (double)g_trk.dt_n / g_trk.dt_acc;
        tt_analyze(&g_trk);
        double f = (g_trk.freq_hz > 0.0) ? g_trk.freq_hz : g_notch_seed_hz;
        if (f > 0.0 && fs > 0.0) {
            notch_design(&g_nx, f, fs, NOTCH_Q);
            notch_design(&g_ny, f, fs, NOTCH_Q);
            if (!g_notch_ready)
                LOGF("notch engaged at %.2f Hz (fs=%.1f, %s)\n",
                     f, fs, g_trk.freq_hz > 0.0 ? "live peak" : "calibrated seed");
            g_notch_ready = 1;
        }
    }
    if (g_notch_ready) {
        *ox = notch_process(&g_nx, (double)rx);
        *oy = notch_process(&g_ny, (double)ry);
    }
}

static void on_pen(UINT msg, WPARAM wParam) {
    UINT32 id = GET_POINTERID_WPARAM(wParam);
    if (id == SYNTH_ID) { g_sentinel++; return; }      /* our own injection */
    /* g_calibrating is the in-process case: measure, do NOT inject, exactly as
     * standalone --calibrate does. The cursor holds still while we measure. */
    if (g_mode == MODE_CALIBRATE || g_calibrating) { calib_sample(id); return; }

    { double tnow = now_s();          /* message-loop health: gap between pen events */
      if (g_lastPenT > 0.0) {
          double gap = (tnow - g_lastPenT) * 1000.0;
          if (gap < 2000.0) { g_gapMs_total += gap; g_gapN++;
                              if (gap > g_gapMs_max) g_gapMs_max = gap; } }
      g_lastPenT = tnow; }

    POINTER_PEN_INFO ppi;
    if (!GetPointerPenInfo(id, &ppi)) return;
    const POINTER_INFO *pi = &ppi.pointerInfo;
    int    rx = pi->ptPixelLocation.x, ry = pi->ptPixelLocation.y;
    UINT32 pressure = (ppi.penMask & PEN_MASK_PRESSURE) ? ppi.pressure : 512;
    int    inContact = (pi->pointerFlags & POINTER_FLAG_INCONTACT) != 0;
    double t = now_s();

    switch (msg) {
    case WM_POINTERDOWN: {
        oneeuro_reset(&g_fx); oneeuro_reset(&g_fy);
        notch_reset(&g_nx); notch_reset(&g_ny);
        g_haveprev = 0;
        double nx, ny; notch_pre(rx, ry, t, &nx, &ny);
        int fx = iround(oneeuro_filter(&g_fx, nx, t));
        int fy = iround(oneeuro_filter(&g_fy, ny, t));
        stat_update(rx, ry, fx, fy);
        inject(fx + DIAG_OFFSET_X, fy, POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE |
                       POINTER_FLAG_INCONTACT | POINTER_FLAG_PRIMARY, pressure);
        g_real++;
        break;
    }
    case WM_POINTERUPDATE:
        if (inContact) {
            double nx, ny; notch_pre(rx, ry, t, &nx, &ny);
            int fx = iround(oneeuro_filter(&g_fx, nx, t));
            int fy = iround(oneeuro_filter(&g_fy, ny, t));
            stat_update(rx, ry, fx, fy);
            inject(fx + DIAG_OFFSET_X, fy, POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE |
                           POINTER_FLAG_INCONTACT | POINTER_FLAG_PRIMARY, pressure);
            g_real++;
        } else {
            /* HOVER. RPIT has already taken the raw pen away from the system, so if
             * we inject nothing here there is no pointer at all: the cursor vanishes
             * whenever the pen is off the surface, and every touch has to create a
             * pointer from scratch (which is what draws the busy/loading cursor).
             * Re-inject an in-range, not-in-contact pen so the cursor stays alive and
             * tracks the pen. Filtered too, so aiming is steady for a tremor user. */
            int fx = iround(oneeuro_filter(&g_fx, rx, t));
            int fy = iround(oneeuro_filter(&g_fy, ry, t));
            inject(fx + DIAG_OFFSET_X, fy,
                   POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_PRIMARY, 0);
            g_hover++;
        }
        break;
    case WM_POINTERUP: {
        int fx = g_fx.primed ? iround(g_fx.x_prev) : rx;
        int fy = g_fy.primed ? iround(g_fy.x_prev) : ry;
        /* Keep INRANGE: the pen has left the surface but is still detected above it.
         * Without this the pointer is destroyed on every stroke end and the cursor
         * disappears until the next contact. */
        inject(fx + DIAG_OFFSET_X, fy,
               POINTER_FLAG_UP | POINTER_FLAG_INRANGE | POINTER_FLAG_PRIMARY, 0);
        g_real++;
        break;
    }
    }
}

/* Start measuring inside the running filter core. Calibration needs pen events,
 * so capture is forced on for the duration even if the UI has us paused; the
 * previous state is restored at the end. */
static void begin_inproc_calibration(void) {
    g_calibrating = 1;
    g_cal_saved_enabled = g_enabled;
    if (!g_registered && RegisterPointerInputTarget(g_hwnd, PT_PEN)) g_registered = 1;
    /* The one-euro pair doubles as calibration's lightly-smoothed REFERENCE path,
     * so it is retuned here and rebuilt from g_cur_* when we finish. */
    oneeuro_init(&g_fx, 0.7, 0.010, 1.0);
    oneeuro_init(&g_fy, 0.7, 0.010, 1.0);
    tt_init(&g_trk);
    g_cal_count = 0; g_cal_steplen = 0.0; g_cal_have = 0;
    g_cal_contact = 0; g_cal_an = 0; g_cal_hz_n = 0; g_cal_win = 0;
    calpath_reset();
    SetTimer(g_hwnd, CAL_TIMER_ID, CAL_SECONDS * 1000, NULL);
    LOGF("config: calibrate=1 -> measuring in-process for %d s\n", CAL_SECONDS);
    write_status(1, g_notch_seed_hz);
}

/* Latch the result, restore the filter, and go straight back to smoothing.
 * hz == 0 means the attempt failed; g_cur_* then still hold the old profile. */
static void end_inproc_calibration(double hz) {
    if (!g_cal_saved_enabled && g_registered) {
        UnregisterPointerInputTarget(g_hwnd, PT_PEN);
        g_registered = 0;
    }
    g_enabled     = g_cal_saved_enabled;
    g_calibrating = 0;
    g_cal_hz      = hz;
    if (hz > 0.0) g_notch_seed_hz = hz;
    oneeuro_init(&g_fx, g_cur_fmin, g_cur_beta, g_dcut);
    oneeuro_init(&g_fy, g_cur_fmin, g_cur_beta, g_dcut);
    notch_reset(&g_nx); notch_reset(&g_ny);
    g_rawlen = g_filtlen = g_maxdev = 0.0; g_haveprev = 0; g_statn = 0;
    LOGF("in-process calibration done hz=%.2f -> fmin=%.2f beta=%.4f, filtering resumed\n",
         hz, g_cur_fmin, g_cur_beta);
    write_status(1, g_notch_seed_hz);
}

static void finish_calibration(HWND hwnd) {
    KillTimer(hwnd, CAL_TIMER_ID);
    calpath_write();     /* flush the tail so the drawn path is complete */
    if (g_cal_count < 20) {
        LOGF("calibrate FAILED: only %u samples\n", g_cal_count);
        /* Guarded like every other calibration dialog: the UI wizard drives this
         * with --no-prompt (or in-process, where there is no console at all) and
         * an unexpected modal box is exactly what it is trying to avoid. */
        if (!g_noprompt && !g_calibrating)
            MessageBoxW(NULL,
                L"Calibration failed - not enough pen movement was detected.\n\n"
                L"Keep the pen touching the tablet and scribble slowly for the full "
                L"10 seconds (Windows Ink enabled), then run --calibrate again.",
                L"Tracey - calibration", MB_OK | MB_ICONWARNING);
        if (g_calibrating) { end_inproc_calibration(0.0); return; }
        g_cal_hz = 0.0;
        write_status(0, 0.0);
        PostQuitMessage(1);
        return;
    }
    double J = g_cal_steplen / g_cal_count;
    /* INTERPOLATE between the three validated presets. Do NOT snap to one.
     *
     * Snapping made calibration's output byte-identical to a card every time,
     * which turned the UI's "Custom" card into a provable no-op: clicking it
     * wrote values that were already live, the core saw no change so it kept
     * publishing a NAMED preset id, and the highlight snapped back inside 200 ms.
     * Two separate attempts to fix that in the renderer each traded one wrong
     * highlight for another, because the ambiguity was in the data, not the view.
     * A genuinely per-user value removes the class instead of the symptom, and it
     * is what "calibrates to the individual" ought to mean in the first place.
     *
     * Anchors are the three cards at J = 2, 4, 6 px, so the midpoints between
     * them fall on 3 and 5, exactly where the old buckets switched. The result is
     * clamped, so it can never leave the validated Gentle..Steadiest span; a very
     * steady or very shaky hand lands exactly ON an endpoint, and that is fine,
     * because `g_preset = -1` below is what keeps Custom selectable, not the
     * values being distinct.
     *
     * UNCHANGED CAVEAT: the J scale is validated only on a steady, non-tremor
     * hand. Interpolating between validated endpoints is not a stronger claim
     * than the buckets were, only a continuous one. A real tremor user is still
     * needed to place these numbers properly. */
    static const double CAL_ANCHOR_J[3] = { 2.0, 4.0, 6.0 };
    int seg = (J < CAL_ANCHOR_J[1]) ? 0 : 1;
    double t = (J - CAL_ANCHOR_J[seg]) / (CAL_ANCHOR_J[seg + 1] - CAL_ANCHOR_J[seg]);
    if (t < 0.0) t = 0.0;
    if (t > 1.0) t = 1.0;
    double fmin = PRESETS[seg].fmin + t * (PRESETS[seg + 1].fmin - PRESETS[seg].fmin);
    double beta = PRESETS[seg].beta + t * (PRESETS[seg + 1].beta - PRESETS[seg].beta);

    cal_window();                 /* the final window counts like any other */
    double hz = cal_tremor_hz();  /* 0 unless a peak PERSISTED across the run */
    /* preset = -1 means "calibrated, not a named preset". That is what makes
     * write_status publish preset=0, the id the UI reserves for Custom, so an
     * explicit Custom click holds instead of being overridden on the next push. */
    save_profile(fmin, beta, -1, hz);            /* hz seeds the --notch center freq */
    g_cur_fmin = fmin; g_cur_beta = beta; g_preset = -1;
    LOGF("calibrate J=%.2f count=%u hz=%.2f (peak in %d/%u windows, need %d%%) "
         "-> calibrated fmin=%.3f beta=%.4f (saved, %s..%s at t=%.2f)\n",
         J, g_cal_count, hz, g_cal_hz_n, g_cal_win, CAL_HZ_MIN_PCT,
         fmin, beta, seg == 0 ? "Gentle" : "Balanced",
         seg == 0 ? "Balanced" : "Steadiest", t);

    /* Live core: adopt the profile we just measured and resume filtering. No
     * dialog, no exit, no relaunch - so no second UAC prompt. */
    if (g_calibrating) { end_inproc_calibration(hz); return; }

    /* NO FREQUENCY IN THIS DIALOG. It used to print "Tremor detected: X.X Hz",
     * which is precisely the readout the product decided never to show a user.
     * The UI wizard has never shown it, so the standing claim that "there is no
     * tremor-detected screen" was true of the GUI and false of this standalone
     * --calibrate path, which the READMEs document and anyone can run.
     *
     * The reason is unchanged by the detector having improved: it ranks GROUPS
     * above chance (AUC 0.754, 95% CI 0.644-0.856) but on this task still reports
     * a tremor for 3 of 20 recordings from a hand that has none, at a
     * clinical-sounding ~5.2 Hz. `hz` is still measured and saved, because it
     * seeds --notch. It is a seed, not a claim to put in front of a person.
     *
     * wsprintfW has no %f, hence the integer decomposition. */
    wchar_t b[520];
    wsprintfW(b,
        L"Calibration complete.\n\n"
        L"Measured amplitude: %d.%02d px (%u samples).\n"
        L"Chosen smoothing: fmin %d.%03d, beta %d.%04d.\n\n"
        L"Saved. Normal launches now use this profile automatically.",
        (int)J, (int)((J - (int)J) * 100 + 0.5), g_cal_count,
        (int)fmin, (int)((fmin - (int)fmin) * 1000 + 0.5),
        (int)beta, (int)((beta - (int)beta) * 10000 + 0.5));
    if (!g_noprompt)
        MessageBoxW(NULL, b, L"Tracey - calibration", MB_OK | MB_ICONINFORMATION);
    /* Publish running=0 only now, AFTER any dialog: this process still holds the
     * single-instance mutex and the pen capture while that box is up, so telling
     * the UI "done" any earlier makes its relaunch bounce off the mutex. */
    g_cal_hz = hz;
    write_status(0, hz);
    PostQuitMessage(0);
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    switch (m) {
    case WM_POINTERDOWN:
    case WM_POINTERUPDATE:
    case WM_POINTERUP:
        on_pen(m, w);
        return 0;
    case WM_TIMER:
        if (w == CAL_TIMER_ID) finish_calibration(h);
        else if (w == POLL_TIMER_ID) poll_config();
        /* Heartbeat: refresh status.cfg 1x/sec so the UI can tell a live core from a
         * killed one by the file's age. Runs in BOTH modes -- calibration has no poll
         * timer, and a stale status.cfg mid-calibration would look like a dead core. */
        else if (w == HB_TIMER_ID) {
            /* Re-probe the tablet on every beat. It costs a few ms, so a 1 Hz
             * re-check is far cheaper than what the UI had to do, and it makes
             * plug/unplug show up in about a second instead of up to 24.
             * Instrumented: this beat is also the UI's liveness signal, so a
             * probe that blocks anywhere near the 3 s staleness threshold is
             * the prime suspect for "the UI thinks the core died". */
            LARGE_INTEGER t0, t1, fq;
            QueryPerformanceCounter(&t0);
            int pen = detect_pen();
            QueryPerformanceCounter(&t1); QueryPerformanceFrequency(&fq);
            {
                long probe_ms = (long)((t1.QuadPart - t0.QuadPart) * 1000 / fq.QuadPart);
                if (probe_ms > 500) LOGF("pen probe took %ld ms on the heartbeat\n", probe_ms);
            }
            if (pen >= 0 && pen != g_pen_present)
                LOGF("pen tablet %s\n", pen ? "connected" : "disconnected");
            if (pen >= 0) g_pen_present = pen;
            write_status(1, g_mode == MODE_CALIBRATE ? 0.0 : g_notch_seed_hz);
        }
        return 0;
    case WM_HOTKEY:
        if (w == 1) PostQuitMessage(0);
        else if (w >= 11 && w <= 13) apply_preset((int)w - 11);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR pCmd, int nShow) {
    (void)hPrev; (void)nShow;

    g_debug    = (pCmd && wcsstr(pCmd, L"debug")) ? 1 : 0;
    g_mode     = (pCmd && wcsstr(pCmd, L"calib")) ? MODE_CALIBRATE : MODE_FILTER;
    g_notch_on = (pCmd && wcsstr(pCmd, L"notch")) ? 1 : 0;
    g_noprompt = (pCmd && wcsstr(pCmd, L"no-prompt")) ? 1 : 0;

    {
        wchar_t dir[MAX_PATH], path[MAX_PATH];
        tt_dir(dir); CreateDirectoryW(dir, NULL);
        tt_file(path, L"tracey.log");
        g_log = _wfopen(path, L"a");
    }

    /* Single instance: exactly ONE core process (filter OR calibrate) at a time.
     * Two cores would both RegisterPointerInputTarget and both inject -> double
     * strokes; and a filter instance running during --calibrate pollutes the
     * samples and fights over status.cfg. */
    HANDLE hOnly = CreateMutexW(NULL, TRUE, L"Global\\TraceyCoreSingleton");
    if (!hOnly || GetLastError() == ERROR_ALREADY_EXISTS) {
        LOGF("another Tracey core is already running -- exiting (mode=%d)\n", g_mode);
        if (g_mode == MODE_CALIBRATE)
            MessageBoxW(NULL,
                L"Tracey is already running.\n\nStop Tracey first (tray: Quit, or "
                L"Ctrl+Alt+Q), then start calibration again.",
                L"Tracey - calibration", MB_OK | MB_ICONWARNING);
        else if (g_debug)
            MessageBoxW(NULL, L"Tracey is already running.", L"Tracey",
                        MB_OK | MB_ICONINFORMATION);
        if (g_log) fclose(g_log);
        return 3;
    }
    QueryPerformanceFrequency(&g_qpf);
    g_pen_present = detect_pen();   /* so the very first status.cfg carries it */

    /* Fullscreen (virtual desktop) layered+transparent+topmost overlay. */
    WNDCLASSW wc; ZeroMemory(&wc, sizeof(wc));
    wc.lpfnWndProc = WndProc; wc.hInstance = hInst; wc.lpszClassName = L"Tracey";
    /* Without a class cursor the pen shows the busy/app-starting cursor over this
     * full-screen overlay (RPIT delivers pen input here, so Windows consults our
     * class). A plain arrow keeps the pointer looking normal while filtering. */
    /* IDC_ARROW is MAKEINTRESOURCEA here (UNICODE is not defined project-wide), so
     * cast for the W API -- the value is an ordinal, not a real string. */
    wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW);
    RegisterClassW(&wc);
    /* MUST cover the full virtual desktop. Tried a 1x1 window (2026-07-27) on the
     * theory that RPIT redirects by registration alone: pen capture still worked,
     * but the injected strokes landed at the WRONG coordinates. The window geometry
     * participates in the pointer coordinate mapping -- do not shrink this. */
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    g_vx = vx; g_vy = vy; g_vw = vw; g_vh = vh;   /* calpath normalises against these */
    /* WS_EX_TOOLWINDOW: an unowned WS_POPUP top-level window gets a taskbar
     * button, so the invisible full-desktop overlay showed up as a "Tracey"
     * entry the user could click (and Alt+Tab to). A tool window is excluded
     * from both. It changes nothing about input: the window is still a real
     * top-level window of the right geometry, which is what RPIT and the
     * pointer coordinate mapping depend on. */
    HWND hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW,
        L"Tracey", L"Tracey", WS_POPUP, vx, vy, vw, vh, NULL, NULL, hInst, NULL);
    if (!hwnd) {
        wchar_t b[128]; wsprintfW(b, L"CreateWindowExW failed: %lu", GetLastError());
        MessageBoxW(NULL, b, L"Tracey", MB_OK | MB_ICONERROR);
        return 1;
    }
    SetLayeredWindowAttributes(hwnd, 0, 1, LWA_ALPHA);
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    g_hwnd = hwnd;

    SetLastError(0);
    BOOL okReg = RegisterPointerInputTarget(hwnd, PT_PEN);
    DWORD regErr = GetLastError();
    g_registered = okReg ? 1 : 0;
    /* Created in BOTH modes. Standalone --calibrate needs it too, or there is no
     * way to inject the hover pointer that keeps the cursor alive while measuring
     * -- without it Windows shows the busy cursor for the whole 10 seconds.
     * _DEFAULT is the validated setting. _NONE was tried (2026-07-27) against the
     * busy-cursor-on-contact symptom and changed nothing, so it was reverted. */
    g_dev = CreateSyntheticPointerDevice(PT_PEN, 1, POINTER_FEEDBACK_DEFAULT);
    LOGF("start mode=%s RPIT(PT_PEN) ok=%d err=%lu synth_dev=%p\n",
         g_mode == MODE_CALIBRATE ? "calibrate" : "filter", okReg, regErr, (void*)g_dev);

    if (!okReg || (g_mode == MODE_FILTER && !g_dev)) {
        wchar_t eb[300];
        wsprintfW(eb,
            L"Tracey failed to start.\n\n"
            L"RegisterPointerInputTarget(PT_PEN): ok=%d (err=%lu)\n"
            L"Synthetic pen device: %s\n\n"
            L"(uiAccess not granted, or run from a non-secure path.)",
            okReg, regErr, g_dev ? L"created" : L"n/a");
        MessageBoxW(NULL, eb, L"Tracey", MB_OK | MB_ICONERROR);
        if (g_dev) DestroySyntheticPointerDevice(g_dev);
        if (g_log) fclose(g_log);
        return 2;
    }

    /* Calibrate mode: measure action tremor, save a profile, exit. */
    if (g_mode == MODE_CALIBRATE) {
        /* Publish running=1 BEFORE the prompt so the UI wizard sees an unambiguous
         * 1 -> 0 transition across the whole calibration (prompt + 5 s capture);
         * finish_calibration() writes running=0 + tremor_hz when it completes. */
        write_status(1, 0.0);
        if (!g_noprompt) MessageBoxW(NULL,
            L"Calibration - measures your drawing tremor.\n\n"
            L"Click OK with the MOUSE (the pen is captured during calibration).\n"
            L"Then, with the pen touching the tablet, draw slow gentle circles or "
            L"scribbles for 10 seconds - let your natural shake happen, don't lift "
            L"the pen. The on-screen cursor won't move; that's expected.",
            L"Tracey - calibration", MB_OK | MB_ICONINFORMATION);
        oneeuro_init(&g_fx, 0.7, 0.010, 1.0);          /* reference smoother */
        oneeuro_init(&g_fy, 0.7, 0.010, 1.0);
        tt_init(&g_trk);
        g_cal_count = 0; g_cal_steplen = 0.0; g_cal_have = 0;
        g_cal_contact = 0; g_cal_an = 0; g_cal_hz_n = 0; g_cal_win = 0;
        calpath_reset();
        SetTimer(hwnd, CAL_TIMER_ID, CAL_SECONDS * 1000, NULL);
        SetTimer(hwnd, HB_TIMER_ID, 1000, NULL);   /* liveness during calibration */
        MSG msg;
        while (GetMessageW(&msg, NULL, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
        UnregisterPointerInputTarget(hwnd, PT_PEN);
        if (g_log) fclose(g_log);
        return 0;
    }

    /* Filter mode: load a calibrated profile if present, else Balanced. */
    g_dcut = 1.0;
    double pf_min, pf_beta;
    if (load_profile(&pf_min, &pf_beta, &g_notch_seed_hz)) {
        g_preset = -1;
        g_cur_fmin = pf_min; g_cur_beta = pf_beta;
        LOGF("loaded profile fmin=%.2f beta=%.4f tremor_hz=%.2f\n", pf_min, pf_beta, g_notch_seed_hz);
    } else {
        g_preset = 1;
        g_cur_fmin = PRESETS[1].fmin; g_cur_beta = PRESETS[1].beta;
        LOGF("no profile; default preset=2 Balanced fmin=%.2f beta=%.4f\n", g_cur_fmin, g_cur_beta);
    }
    oneeuro_init(&g_fx, g_cur_fmin, g_cur_beta, g_dcut);
    oneeuro_init(&g_fy, g_cur_fmin, g_cur_beta, g_dcut);
    if (g_notch_on) {
        tt_init(&g_trk); notch_reset(&g_nx); notch_reset(&g_ny);
        if (g_notch_seed_hz > 0.0)
            LOGF("--notch enabled (Q=%.1f), seeded at calibrated %.2f Hz\n", (double)NOTCH_Q, g_notch_seed_hz);
        else
            LOGF("--notch enabled (Q=%.1f) but no calibrated tremor freq -- run --calibrate first "
                 "or it stays dormant\n", (double)NOTCH_Q);
    }

    RegisterHotKey(hwnd, 1, MOD_CONTROL | MOD_ALT, 'Q');
    for (int k = 0; k < 3; k++) RegisterHotKey(hwnd, 11 + k, MOD_CONTROL | MOD_ALT, '1' + k);

    /* UI control channel: publish status, ignore any pre-existing config.cfg
     * (profile is the startup default), and poll ~5x/sec for live UI changes. */
    write_status(1, g_notch_seed_hz);
    g_cfg_mtime = cfg_mtime();
    SetTimer(hwnd, POLL_TIMER_ID, 200, NULL);
    SetTimer(hwnd, HB_TIMER_ID, 1000, NULL);

    if (g_debug) {
        MessageBoxW(NULL,
            L"Tracey is ACTIVE (debug).\n\n"
            L"Draw with the pen; the one-euro filter smooths tremor.\n"
            L"Ctrl+Alt+1..3 = Gentle / Balanced / Steadiest (beeps N times).\n"
            L"Ctrl+Alt+Q  = quit.",
            L"Tracey", MB_OK | MB_ICONINFORMATION);
    }

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); }

    KillTimer(hwnd, POLL_TIMER_ID);
    KillTimer(hwnd, HB_TIMER_ID);
    UnregisterHotKey(hwnd, 1);
    for (int k = 0; k < 3; k++) UnregisterHotKey(hwnd, 11 + k);
    if (g_registered) UnregisterPointerInputTarget(hwnd, PT_PEN);
    if (g_dev) DestroySyntheticPointerDevice(g_dev);   /* NULL if creation failed */
    write_status(0, g_notch_seed_hz);   /* tell the UI we've stopped */

    double reduction = (g_rawlen > 0.0) ? (100.0 * (g_rawlen - g_filtlen) / g_rawlen) : 0.0;
    LOGF("stop real=%u hover=%u injOk=%u injFail=%u sentinel=%u\n",
         g_real, g_hover, g_injOk, g_injFail, g_sentinel);
    LOGF("pathlen raw=%.0f filt=%.0f reduction=%.1f%% maxdev=%.1f\n", g_rawlen, g_filtlen, reduction, g_maxdev);
    LOGF("latency inject_avg=%.0fus inject_max=%.0fus n=%u | pen_gap_avg=%.1fms pen_gap_max=%.1fms n=%u\n",
         g_injN ? g_injUs_total / g_injN : 0.0, g_injUs_max, g_injN,
         g_gapN ? g_gapMs_total / g_gapN : 0.0, g_gapMs_max, g_gapN);
    if (!g_debug) { if (g_log) fclose(g_log); return 0; }

    wchar_t qb[600];
    wsprintfW(qb,
        L"Stopped.\n\n"
        L"Real pen samples filtered: %u\n"
        L"Injected ok / fail: %u / %u\n"
        L"Own-injection re-captured (sentinel): %u\n\n"
        L"raw path = %d px, filtered = %d px, jitter removed = %d%%, max dev = %d px\n"
        L"Active: fmin*100=%d beta*1000=%d (%s)",
        g_real, g_injOk, g_injFail, g_sentinel,
        (int)g_rawlen, (int)g_filtlen, (int)(reduction + 0.5), (int)(g_maxdev + 0.5),
        (int)(g_cur_fmin * 100 + 0.5), (int)(g_cur_beta * 1000 + 0.5),
        g_preset >= 0 ? L"preset" : L"calibrated");
    MessageBoxW(NULL, qb, L"Tracey - summary", MB_OK | MB_ICONINFORMATION);
    if (g_log) fclose(g_log);
    return 0;
}
