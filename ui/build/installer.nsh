; Tracey installer - the parts electron-builder cannot do on its own.
;
; Three things have to happen or the product is silently broken:
;
;   1. The signing certificate must be trusted by THIS machine, or Windows
;      refuses to launch the core at all (measured: Win32 8235, no UAC prompt,
;      no core process, nothing in the core's log). Root store ONLY - measured
;      that Root alone grants uiAccess and TrustedPublisher alone does not.
;
;   2. %PROGRAMDATA%\Tracey must exist and grant BUILTIN\Users Modify. The core
;      runs elevated and the UI does not; they talk only through text files in
;      that folder. Without the grant every slider and switch fails silently.
;
;   3. The core must land in %ProgramFiles%\Tracey. uiAccess requires a secure
;      path - this is why allowToChangeInstallationDirectory is false. A user
;      picking D:\Apps would produce an install that looks fine and never
;      filters a single stroke.
;
; S-1-5-32-545 is BUILTIN\Users by SID, so this works on a non-English Windows.

; ---------------------------------------------------------------- desktop link
; electron-builder can only create the desktop shortcut unconditionally or never
; (createDesktopShortcut true/false) - it has no "ask" mode. So it is set to
; false, which defines DO_NOT_CREATE_DESKTOP_SHORTCUT, and we own the shortcut
; entirely: page, creation AND removal. That last part is easy to miss - the same
; define also disables the UNINSTALLER's desktop cleanup, so without the Delete in
; customUnInstall below, uninstalling would leave a dead shortcut behind.
!macro customHeader
  !include nsDialogs.nsh
  !include LogicLib.nsh

  ; electron-builder's common.nsh sets both of these to `nevershow`, and this
  ; include lands after it, so these win. Something that installs a trusted
  ; certificate and a privileged background process should be willing to show
  ; exactly what it put on the machine.
  ShowInstDetails show
  ShowUninstDetails show

; The UNINSTALLER is a SEPARATE NSIS compile that also inserts customHeader, but
; never inserts customPageAfterChangeDir or customInstall - it has no install
; pages. Anything here that only the installer uses is therefore dead code over
; there, and electron-builder compiles with warnings-as-errors, so NSIS's
; "function not referenced - zeroing code out" (6010) and "variable not
; referenced or never set" (6001) are both build FAILURES rather than notices.
; Everything below is installer-only: the checkbox page and the two variables
; that carry its answer into customInstall. customUnInstall needs neither - it
; deletes a fixed path.
!ifndef BUILD_UNINSTALLER
  Var TraceyDesktopCheckbox
  Var TraceyWantDesktop

  Function TraceyShortcutPageCreate
    !insertmacro MUI_HEADER_TEXT "Desktop shortcut" "Choose how you want to open Tracey."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ; The install location is worth showing precisely because it CANNOT be
    ; changed - a user who is not told where their software went, and is given no
    ; choice either, is entitled to wonder. Saying why costs one line.
    ${NSD_CreateLabel} 0 0 100% 11u "Tracey will be installed to:"
    Pop $1
    ${NSD_CreateLabel} 8u 13u 100% 11u "$INSTDIR"
    Pop $1
    ${NSD_CreateLabel} 0 28u 100% 22u "This location is fixed. Windows only grants Tracey \
permission to steady your pen when it runs from a protected folder."
    Pop $1
    ${NSD_CreateLabel} 0 54u 100% 11u "Tracey is always available from the Start menu."
    Pop $1
    ${NSD_CreateCheckbox} 0 68u 100% 12u "Create a desktop shortcut"
    Pop $TraceyDesktopCheckbox
    ; Ticked by default: the people this is built for should not have to go
    ; hunting through the Start menu to turn their pen steadying on.
    ${If} $TraceyWantDesktop == 1
      ${NSD_Check} $TraceyDesktopCheckbox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function TraceyShortcutPageLeave
    ${NSD_GetState} $TraceyDesktopCheckbox $TraceyWantDesktop
  FunctionEnd
!endif
!macroend

!macro customPageAfterChangeDir
  Page custom TraceyShortcutPageCreate TraceyShortcutPageLeave
!macroend

!macro customInit
  ; Default ON. Also the value a SILENT install (/S) uses, since it never shows
  ; the page - matching what the visible installer offers rather than quietly
  ; doing less.
  StrCpy $TraceyWantDesktop 1

  ; The core holds the exe open. electron-builder closes the UI for us but knows
  ; nothing about the core, so an upgrade over a running core fails to copy.
  ; The installer is elevated, so it can kill the elevated core. A hard kill
  ; leaves running=1 in status.cfg, which the UI already treats as dead after 3s.
  ; BOTH names: the installer ships the core as tracey-core.exe, but build.ps1's
  ; development install is tracey.exe and either one holds the exe open.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM tracey-core.exe'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM tracey.exe'
!macroend

!macro customInstall
  ; installSection.nsh does `SetDetailsPrint none` at the TOP of the section, so
  ; the per-file extraction lines are suppressed before anything custom runs and
  ; cannot be recovered from here. Rather than 200 lines of "Extract: *.dll",
  ; enumerate what actually landed - and keep printing for everything below, so
  ; the certificate and permission steps are visible too. FindFirst walks the
  ; real directory instead of a hardcoded list, so this cannot drift from what
  ; the installer actually ships.
  SetDetailsPrint both
  DetailPrint "----------------------------------------------------------------"
  DetailPrint "Installed to $INSTDIR :"
  FindFirst $0 $1 "$INSTDIR\*.*"
  traceyListLoop:
    StrCmp $1 "" traceyListDone
    StrCmp $1 "." traceyListNext
    StrCmp $1 ".." traceyListNext
    ${If} ${FileExists} "$INSTDIR\$1\*.*"
      DetailPrint "   [folder] $1"
    ${Else}
      DetailPrint "   $1"
    ${EndIf}
    traceyListNext:
    FindNext $0 $1
    Goto traceyListLoop
  traceyListDone:
  FindClose $0
  DetailPrint "----------------------------------------------------------------"

  SetShellVarContext all          ; makes $APPDATA mean C:\ProgramData, not the user's
  DetailPrint "Settings folder: $APPDATA\Tracey (kept if you uninstall)"
  CreateDirectory "$APPDATA\Tracey"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$APPDATA\Tracey" /grant "*S-1-5-32-545:(OI)(CI)M"'
  nsExec::ExecToLog '"$SYSDIR\certutil.exe" -addstore -f Root "$INSTDIR\TraceyDevSigning.cer"'

  ; SetShellVarContext all is still in force, so $DESKTOP is the ALL-USERS desktop.
  ; That is deliberate and matches a per-machine install: on a shared computer the
  ; person who needs the pen steadying may not be the one who installed it.
  ${If} $TraceyWantDesktop == 1
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" \
                   "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ${EndIf}
!macroend

!macro customUnInit
  ; BOTH names: the installer ships the core as tracey-core.exe, but build.ps1's
  ; development install is tracey.exe and either one holds the exe open.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM tracey-core.exe'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM tracey.exe'
!macroend

!macro customUnInstall
  SetDetailsPrint both
  ; Remove the certificate by THUMBPRINT, not by name: a name match would also
  ; catch an unrelated certificate that happened to share the subject.
  DetailPrint "Removing the Tracey security certificate from Trusted Root..."
  nsExec::ExecToLog '"$SYSDIR\certutil.exe" -delstore Root F90ABC23764242A1E6D0CCD57E976DAB6CFCB09F'

  ; Ours to clean up, because DO_NOT_CREATE_DESKTOP_SHORTCUT also switches OFF the
  ; uninstaller's own desktop cleanup. Same shell-var context as when it was made,
  ; or this deletes nothing and leaves a shortcut pointing at a removed exe.
  SetShellVarContext all
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"

  ; ASK before removing the settings folder, and default to KEEPING it.
  ; %PROGRAMDATA%\Tracey holds profile.cfg - the calibration the user scribbled
  ; ten seconds for - plus their smoothing settings. Deleting it silently would
  ; make a reinstall cost them that work, and keeping it silently gives someone
  ; who wanted a clean slate no way to get one. So: ask.
  ; ${Silent} guard is load-bearing - a MessageBox in a silent uninstall waits
  ; forever on a dialog nobody can see, which reads as a hung uninstaller.
  ; Silent keeps the data, matching the default of the visible prompt.
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your Tracey settings and calibration?$\r$\n$\r$\nThis removes $APPDATA\Tracey, including the calibration you recorded. Choose No to keep them for a future reinstall." \
      IDYES traceyWipeData IDNO traceyKeepData
    traceyWipeData:
      DetailPrint "Deleting settings and calibration: $APPDATA\Tracey"
      RMDir /r "$APPDATA\Tracey"
      Goto traceyDataDone
    traceyKeepData:
      DetailPrint "Keeping settings and calibration: $APPDATA\Tracey"
    traceyDataDone:
  ${EndIf}

  ; Windows will not let an uninstaller delete the folder it is executing from,
  ; so an empty $INSTDIR is left behind. Accepted as cosmetic - but say so,
  ; because a leftover Program Files folder otherwise looks like a failed
  ; uninstall to anyone who goes and checks.
  DetailPrint ""
  DetailPrint "Note: the now-empty folder $INSTDIR may remain."
  DetailPrint "Windows does not allow an uninstaller to remove the folder it is"
  DetailPrint "running from. It is empty and safe to delete by hand."
  ; %PROGRAMDATA%\Tracey is deliberately LEFT BEHIND. It holds profile.cfg - the
  ; calibration the user spent ten seconds scribbling for - and reinstalling
  ; should not cost them that. It contains no secrets, only filter parameters.
!macroend
