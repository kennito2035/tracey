<#
v1/build.ps1
Reproducible build of the native (C) Tracey core: compile -> embed the uiAccess
manifest -> sign -> install to %ProgramFiles%\Tracey.

WHY NATIVE: a uiAccess="true" Python exe dies in the Windows loader before any
Python runs; a native C uiAccess exe does not. See CLAUDE.md / memory
tracey-uiaccess-diagnosis.

RUN AS ADMINISTRATOR:
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    .\build.ps1
Then launch from a NON-elevated shell (triggers real UAC):
    Start-Process "C:\Program Files\Tracey\tracey.exe"

-NoInstall builds and signs into dist\ but skips the copy into %ProgramFiles%,
which is the only step that needs elevation. Use it when you just want a fresh
signed core to hand to the installer, or to rebuild from a normal shell.
#>
param([switch]$NoInstall)
$ErrorActionPreference = "Stop"

$CERT_SUBJECT = "CN=Tracey Dev Signing"
$INSTALL_DIR  = "C:\Program Files\Tracey"
$EXE_NAME     = "tracey.exe"
$SRC_DIR      = $PSScriptRoot
$SRC          = Join-Path $SRC_DIR "tracey.c"
$MANIFEST     = Join-Path (Split-Path -Parent $SRC_DIR) "packaging\uiaccess_manifest.xml"
$RC           = Join-Path (Split-Path -Parent $SRC_DIR) "packaging\tracey.rc"
$OUT_DIR      = Join-Path (Split-Path -Parent $SRC_DIR) "dist"
$OUT_EXE      = Join-Path $OUT_DIR $EXE_NAME

function Find-Under($roots, $name, $mustMatch) {
    foreach ($r in $roots) {
        if (Test-Path $r) {
            $f = Get-ChildItem -Path $r -Recurse -Filter $name -ErrorAction SilentlyContinue |
                 Where-Object { $_.FullName -match $mustMatch } |
                 Sort-Object FullName -Descending | Select-Object -First 1
            if ($f) { return $f.FullName }
        }
    }
    return $null
}

Write-Host "[1/5] Locating MSVC (vcvars64.bat)..." -ForegroundColor Cyan
$vcvars = Find-Under @(
    "C:\Program Files\Microsoft Visual Studio",
    "C:\Program Files (x86)\Microsoft Visual Studio"
) "vcvars64.bat" "Auxiliary\\Build"
if (-not $vcvars) { throw "vcvars64.bat not found. Install VS Build Tools with the C++ workload." }
Write-Host "      $vcvars"

Write-Host "[2/5] Compiling $EXE_NAME ..." -ForegroundColor Cyan
if (-not (Test-Path $OUT_DIR)) { New-Item -ItemType Directory -Force $OUT_DIR | Out-Null }
$obj = Join-Path $OUT_DIR "tracey.obj"
$res = Join-Path $OUT_DIR "tracey.res"
if (-not (Test-Path $RC)) { throw "Resource script not found: $RC" }
# rc.exe first, then cl with the .res on the command line - cl hands any .res
# straight to the linker. rc comes from the SDK, which vcvars puts on PATH, so
# this does not need the Find-Under lookup that mt/signtool use below.
# WITHOUT this the exe has no icon and no version strings, and the UAC prompt -
# the first thing a user ever sees - shows a blank icon and a bare filename.
cmd /c "`"$vcvars`" && rc /nologo /fo `"$res`" `"$RC`" && cl /nologo /W3 /O2 /utf-8 /D_CRT_SECURE_NO_WARNINGS /I `"$SRC_DIR`" `"$SRC`" `"$res`" /Fe:`"$OUT_EXE`" /Fo:`"$obj`" /link user32.lib setupapi.lib cfgmgr32.lib /SUBSYSTEM:WINDOWS"
if (-not (Test-Path $res))     { throw "Resource compile failed; $res not produced." }
if (-not (Test-Path $OUT_EXE)) { throw "Compile failed; $OUT_EXE not produced." }
Write-Host "      Built: $OUT_EXE (icon + version resources embedded)"

Write-Host "[3/5] Finding signing cert + SDK tools..." -ForegroundColor Cyan
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CERT_SUBJECT } | Select-Object -First 1
if (-not $cert) {
    Write-Host "      Creating self-signed cert $CERT_SUBJECT"
    $cert = New-SelfSignedCertificate -Subject $CERT_SUBJECT -Type CodeSigningCert `
        -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2)
}
Write-Host "      Cert thumbprint: $($cert.Thumbprint)"

# Machine trust is re-checked EVERY run, not only when the cert is created. The cert can
# survive in CurrentUser\My while the LocalMachine stores are cleared -- exactly what
# happens when the box is stripped for a clean-install test. In that state signtool still
# signs happily, but step [4/5]'s Get-AuthenticodeSignature returns UnknownError ("root
# not trusted") and the build dies with nothing pointing at the real cause. Nesting this
# inside the creation branch made that unrecoverable: the cert exists, so it never ran.
foreach ($s in @("Root","TrustedPublisher")) {
    if (Get-ChildItem "Cert:\LocalMachine\$s" | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }) { continue }
    try {
        $store = Get-Item "Cert:\LocalMachine\$s"; $store.Open("ReadWrite"); $store.Add($cert); $store.Close()
        Write-Host "      Trusted cert in LocalMachine\$s" -ForegroundColor Yellow
    } catch {
        throw "Cert $($cert.Thumbprint) is NOT trusted in LocalMachine\$s and this shell cannot write there. Re-run build.ps1 from an ELEVATED PowerShell."
    }
}
$kits = @("C:\Program Files (x86)\Windows Kits\10\bin","C:\Program Files\Windows Kits\10\bin")
$mt = Find-Under $kits "mt.exe" "x64"; if (-not $mt) { throw "mt.exe not found (Windows SDK)." }
$signtool = Find-Under $kits "signtool.exe" "x64"; if (-not $signtool) { throw "signtool.exe not found (Windows SDK)." }

Write-Host "[4/5] Embedding uiAccess manifest + signing..." -ForegroundColor Cyan
& $mt -manifest $MANIFEST -outputresource:"$OUT_EXE;#1"
if ($LASTEXITCODE -ne 0) { throw "mt.exe manifest embed failed." }
& $signtool sign /sha1 $cert.Thumbprint /fd SHA256 /t http://timestamp.digicert.com $OUT_EXE
if ($LASTEXITCODE -ne 0) { throw "signtool signing failed." }
$sig = Get-AuthenticodeSignature $OUT_EXE
if ($sig.Status -ne "Valid") { throw "Signature not Valid: $($sig.Status)" }
Write-Host "      Signed; signature Valid."

if ($NoInstall) {
    Write-Host "[5/5] -NoInstall: leaving the signed core in $OUT_EXE" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "DONE (not installed)." -ForegroundColor Green
    Write-Host "Install it with the Tracey installer, or elevate and re-run without -NoInstall."
    return
}

Write-Host "[5/5] Installing to $INSTALL_DIR ..." -ForegroundColor Cyan
if (-not (Test-Path $INSTALL_DIR)) { New-Item -ItemType Directory -Force $INSTALL_DIR | Out-Null }
Copy-Item $OUT_EXE (Join-Path $INSTALL_DIR $EXE_NAME) -Force
Write-Host "      Installed: $(Join-Path $INSTALL_DIR $EXE_NAME)"

# Control-channel folder: create it here (elevated) and grant Users Modify, so the
# NON-elevated UI can always write config.cfg. Without this, a config.cfg that ever
# gets created by an elevated process becomes admin-owned and every UI slider write
# fails silently. S-1-5-32-545 = BUILTIN\Users (locale-independent).
$DATA_DIR = Join-Path $env:ProgramData "Tracey"
if (-not (Test-Path $DATA_DIR)) { New-Item -ItemType Directory -Force $DATA_DIR | Out-Null }
& icacls $DATA_DIR /grant "*S-1-5-32-545:(OI)(CI)M" | Out-Null
Write-Host "      Control channel: $DATA_DIR (Users: Modify)"

Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "Launch from a NON-elevated shell (triggers real UAC):"
Write-Host "  Start-Process `"$INSTALL_DIR\$EXE_NAME`""
