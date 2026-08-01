# Release checklist: after fix/verified-defects merges

The branch changes the C core, the UI, and the test gate. Each of those has a
knock-on that is easy to forget under deadline. Work this list top to bottom;
do not skip a step because a check is green (this project has been burned by
green checks twice).

1. Merge via PR into main, not a direct push, so the per-fix history stays
   legible: one commit per defect, symptom first, cause second.

2. Rebuild and re-sign the core with `src/build.ps1` (elevated). The C changed
   (atomic status writes, the pen-probe thread, instrumentation), so the
   binary and its signature both change. `build.ps1 -NoInstall` builds without
   the Program Files copy if only the artifact is needed.

3. Repack the installer (`npm run dist` in ui/ after `prepare-core`). Then
   CONFIRM the certificate thumbprint the uninstaller deletes
   (ui/build/installer.nsh, the `certutil -delstore Root` line) matches the
   thumbprint of the certificate the installer actually trusts (the
   TraceyDevSigning.cer it ships). On the machine that built the published
   v0.1.0 these match at F90ABC23764242A1E6D0CCD57E976DAB6CFCB09F; any OTHER
   build machine mints a fresh certificate and the hardcoded value is then
   WRONG, which leaves a trusted root certificate behind on every uninstall.
   Verify, do not assume:
   `certutil -dump ui/build/core/TraceyDevSigning.cer` and compare.

4. Re-tag the release. The old v0.1.0 asset bytes are stale the moment the
   core or UI changes; a tag pointing at new source with an old installer
   attached is a false statement.

5. Re-hash. The published SHA256 of Tracey-Setup-*.exe changes with the new
   bytes. Update it everywhere it is quoted, then re-run the verification:
   download the asset back from the release page, `certutil -hashfile` it,
   and compare against both the documented value and the digest GitHub
   reports for the asset.

6. Re-run the 10-step smoke test on the REBUILT core, end to end, with a real
   pen: install on a machine that has never trusted the certificate, confirm
   the consent page appears before anything is written, confirm capture,
   filtering and re-injection in a real app, confirm tray states, calibration,
   the hotkeys, and a clean uninstall that removes the certificate. A green
   verify.js proves the UI side against a mock only; the smoke test is the
   only thing that proves the real core.

   Add one step for tilt, which is new and unproven on hardware: draw in a
   tilt-aware brush (Photoshop, Krita or Fresco) with Tracey ON and confirm the
   brush responds to pen angle, then check tracey.log at shutdown. The line
   `tilt forwarded=yes sent=N` with N greater than 0 is the proof it flowed;
   `sent=0` with a tilt-capable pen attached means the device never reported
   tilt, and `forwarded=disabled-after-refusal` means Windows rejected it and
   Tracey fell back to pressure only. src/test_tilt.c covers the logic without
   a tablet, but only this step proves the app receives the angle.

7. Schedule the Electron runtime upgrade. npm audit shows the shipped
   electron 32.3.3 carries high-severity runtime advisories (use-after-free
   in permission callbacks GHSA-8337-3p73-46f4, offscreen paint
   GHSA-532v-xpq5-8h95, PowerMonitor on Windows GHSA-jjp3-mq3x-295m, renderer
   switch injection GHSA-9wfr-w7mm-pc7f); the fix line is electron 43.2.0, a
   major bump that needs its own test pass. Every other advisory in the audit
   is build-toolchain only and does not ship. Not a blocker for this merge;
   do not let it age past the next release.

Staged push for the branch (do not run until every gate in the pre-push run
is green and the run's final report says ready):

```
git push -u origin fix/verified-defects
```
