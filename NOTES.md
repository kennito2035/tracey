# NOTES: Defect B (tray destroyed by one bad status reading), instrumentation record

## The defect

`updateTray()` destroys the tray icon (and restores a hidden window) the moment a
single status read maps to trayState 'off'. Two candidate root causes were named.
This file records what was measured, what shipped to discriminate them in the
field, and which mechanisms are closed.

## Candidate 1: the empty-file window. Mechanism CONFIRMED on Windows.

`write_status()` truncated status.cfg in place (`_wfopen(L"w")`; buffered content
lands at `fclose`). Between open and close the file is legitimately empty; an
empty read parses to no keys, `running` defaulted to 0, and the tray was
destroyed. No error fires anywhere on that path.

Measured on this machine (Windows 11, NTFS, a CRT harness reproducing the
MSVCRT open-truncate, buffered-write, close sequence at 50 writes/s against a
tight reader, 20 s per scenario):

| scenario                                        | reads   | empty reads |
|-------------------------------------------------|---------|-------------|
| truncate in place, no hold (the shipped pattern) | 186,558 | 668         |
| truncate + 300 us hold (positive control)        | 213,987 | 8,110       |
| temp file + replace (the fix pattern)            | 193,362 | 0           |

The positive control validates the harness. The no-hold row shows the shipped
pattern handed a reader an empty file roughly 0.4% of the time at that read
rate, notably wider than the Linux demonstration (322 in 3.2M). The atomic row
shows the fix closes the window completely.

The harness also surfaced a second-order hazard: in the atomic scenario the CRT
reader hit 12,349 transient open failures (sharing violations during the
replace). The UI reads with Node, which opens with FILE_SHARE_DELETE, so it is
far less exposed than the CRT reader, but a transient EPERM/EBUSY read during a
replace remains possible, and readStatus used to classify ANY read error as
core-gone, which also reaches trayState as 'off'. The torn-read hardening
therefore covers transient errors too.

## Candidate 2: the detect_pen stall. NOT OBSERVED YET; closed structurally.

The 1 Hz heartbeat called `detect_pen()` inline. A probe stalled past ~2 s makes
the next status write LATE (not missed), the UI's 3000 ms staleness rule fires,
and the core is declared dead. Observing this needs a live pen session under
driver load, which this machine could not run (no installed core during the fix
session). It is closed structurally regardless: the probe now runs on its own
thread and the heartbeat only adopts its latest published answer.

## What ships to settle which candidate ever fired in production

- `write_status` logs any gap over 2500 ms between consecutive status.cfg
  writes: `status: N ms between status.cfg writes (UI stale threshold 3000)`.
  A line here is candidate 2's signature.
- The pen probe logs any run over 500 ms: `pen probe took N ms`. The line is
  skipped once shutdown has been signalled, so a stall that only completes
  during exit leaves no line.
- `readStatus` logs every torn or transiently unreadable status read to ui.log.
  Torn reads log `status.cfg torn read (N bytes, age N ms); kept last known
  status`; transient read errors log `status.cfg transient read error (CODE);
  kept last known status`. Grep for `kept last known status` to count both. A
  line here coinciding with a tray rebuild would have been candidate 1's
  signature; after the atomic write it should never appear against a current
  core.

## Status of the fixes

1. `write_status` atomic (temp + MoveFileExW, retried): candidate 1's window
   measured closed (0 empty reads in 193,362).
2. `readStatus` torn-read hardening: empty, keyless and transient-error reads
   return the last known status flagged `torn: true`; an empty file older than
   STALE_MS still reads as dead, a deleted file stays definitive. Eight verify
   checks freeze each moment of the window.
3. `detect_pen` off the liveness path (probe thread).
4. The grace-period fallback (destroy only on a second consecutive 'off') is
   deliberately NOT implemented: both causal mechanisms are removed, and the
   log lines above will name any residual path if one exists. Revisit only if
   they do.
