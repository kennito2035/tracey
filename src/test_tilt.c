/* Exercises the REAL inject() from src/tracey.c, not a replica.
 *
 * InjectSyntheticPointerInput is renamed by the macro below BEFORE windows.h is
 * pulled in by tracey.c, so the SDK's own declaration becomes the stub's and the
 * signature cannot drift. tracey.c is then included whole, which means the code
 * under test is byte-for-byte the shipping code.
 */
/* windows.h FIRST, so the SDK's own dllimport declaration of the real function
 * is processed before the macro exists. The macro then rewrites only the call
 * site inside tracey.c, and the real API is never reached. */
#define WINVER       0x0A00
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdio.h>

/* What the stub saw on the last call, plus the knob that makes it refuse. */
static POINTER_TYPE_INFO g_last;
static int  g_calls        = 0;
static int  g_refuse_tilt  = 0;   /* 1 = fail any call carrying tilt */
static int  g_refusals     = 0;

static BOOL WINAPI stub_inject(HSYNTHETICPOINTERDEVICE dev, const POINTER_TYPE_INFO *info, UINT32 count) {
    (void)dev; (void)count;
    g_calls++;
    g_last = *info;
    if (g_refuse_tilt && (info->penInfo.penMask & (PEN_MASK_TILT_X | PEN_MASK_TILT_Y))) {
        g_refusals++;
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    return TRUE;
}

#define InjectSyntheticPointerInput stub_inject
#define wWinMain                    tracey_wwinmain_unused
#include "tracey.c"

static int failures = 0;
static void check(const char *name, int cond) {
    printf("  %s %s\n", cond ? "PASS" : "FAIL", name);
    if (!cond) failures++;
}

static POINTER_PEN_INFO src_with(UINT32 mask, INT32 tx, INT32 ty) {
    POINTER_PEN_INFO p;
    ZeroMemory(&p, sizeof(p));
    p.penMask = mask;
    p.tiltX = tx; p.tiltY = ty;
    return p;
}

int main(void) {
    /* wWinMain normally does these two; the harness never runs it. Without the
     * critical section LOGF faults on an uninitialised lock, and g_qpf is only
     * used for timing arithmetic. */
    InitializeCriticalSection(&g_log_cs);
    QueryPerformanceFrequency(&g_qpf);

    /* Negative control: TILT_OFF=1 disables forwarding up front, which must make
     * the forwarding assertions FAIL. A suite that passes either way proves
     * nothing. */
    if (getenv("TILT_OFF")) { g_tilt_fwd = 0; printf("[negative control: forwarding disabled]\n"); }

    const POINTER_FLAGS DOWN = POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE |
                               POINTER_FLAG_INCONTACT | POINTER_FLAG_PRIMARY;
    printf("--- tilt forwarding ---\n");

    POINTER_PEN_INFO tilted = src_with(PEN_MASK_PRESSURE | PEN_MASK_TILT_X | PEN_MASK_TILT_Y, 30, -45);
    inject(100, 200, DOWN, 512, &tilted);
    check("tilt X and Y masks are set on the injected pointer",
          (g_last.penInfo.penMask & PEN_MASK_TILT_X) && (g_last.penInfo.penMask & PEN_MASK_TILT_Y));
    check("tilt values pass through unchanged (30, -45)",
          g_last.penInfo.tiltX == 30 && g_last.penInfo.tiltY == -45);
    check("pressure still forwarded alongside tilt",
          (g_last.penInfo.penMask & PEN_MASK_PRESSURE) && g_last.penInfo.pressure == 512);

    printf("--- a device that reports no tilt ---\n");
    POINTER_PEN_INFO plain = src_with(PEN_MASK_PRESSURE, 0, 0);
    inject(100, 200, DOWN, 512, &plain);
    check("no tilt mask is invented when the source has none",
          !(g_last.penInfo.penMask & (PEN_MASK_TILT_X | PEN_MASK_TILT_Y)));

    printf("--- only one axis reported ---\n");
    POINTER_PEN_INFO xonly = src_with(PEN_MASK_PRESSURE | PEN_MASK_TILT_X, 12, 77);
    inject(100, 200, DOWN, 512, &xonly);
    check("X forwarded, Y left alone when only X is reported",
          (g_last.penInfo.penMask & PEN_MASK_TILT_X) &&
          !(g_last.penInfo.penMask & PEN_MASK_TILT_Y) &&
          g_last.penInfo.tiltX == 12 && g_last.penInfo.tiltY == 0);

    printf("--- out-of-range values ---\n");
    POINTER_PEN_INFO wild = src_with(PEN_MASK_TILT_X | PEN_MASK_TILT_Y, 4000, -4000);
    inject(100, 200, DOWN, 512, &wild);
    check("clamped to the documented -90..90",
          g_last.penInfo.tiltX == 90 && g_last.penInfo.tiltY == -90);

    printf("--- a machine that refuses tilt ---\n");
    g_refuse_tilt = 1;
    int callsBefore = g_calls;
    unsigned okBefore = g_injOk;
    inject(100, 200, DOWN, 512, &tilted);
    check("the refusal is retried, so the stroke sample is NOT dropped", g_injOk == okBefore + 1);
    check("the retry carried no tilt",
          !(g_last.penInfo.penMask & (PEN_MASK_TILT_X | PEN_MASK_TILT_Y)));
    check("the retry still carried pressure", g_last.penInfo.pressure == 512);
    check("exactly one extra call was made (one retry, not a loop)", g_calls == callsBefore + 2);
    check("forwarding latched off", g_tilt_fwd == 0);

    callsBefore = g_calls;
    g_refusals = 0;
    inject(101, 201, DOWN, 512, &tilted);
    check("later injections no longer attempt tilt at all", g_refusals == 0);
    check("and cost only one call each", g_calls == callsBefore + 1);

    printf("\n%s (%d failures)\n", failures ? "FAILURES" : "ALL TILT TESTS PASSED", failures);
    return failures ? 1 : 0;
}
