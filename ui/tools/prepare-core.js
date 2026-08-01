#!/usr/bin/env node
'use strict';
/*
 * Stage the signed core + its certificate into build/core/ so electron-builder
 * can pick them up with a path that lives INSIDE this project.
 *
 * Why not point extraFiles straight at ../../dist? Because that path is only
 * correct in the development checkout. In the public handoff repo `ui/` sits one
 * level down from the repo root and build.ps1 writes its dist/ somewhere else
 * again, so a hardcoded relative path silently packages nothing - and an
 * installer that ships no core is the one failure that looks completely fine
 * until someone tries to draw. Search the known layouts, verify what we found,
 * and fail loudly otherwise.
 *
 * This deliberately refuses to build if the core is unsigned: an unsigned core
 * cannot get uiAccess, so the resulting installer would be dead on arrival.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UI = path.resolve(__dirname, '..');
const OUT = path.join(UI, 'build', 'core');

// Every layout the core is built into. Order is no longer what decides: a machine
// that carries BOTH the private development tree and a clone of this repo has a
// dist/ in each, and taking the first match meant a months-old core from the other
// tree could shadow the one just built. That is not hypothetical, it shipped an
// installer containing the exact stale core the release existed to replace, and
// every check passed: the stale core is signed, valid, and the right filename, so
// the signature gate below cannot see it. Only its CONTENT was wrong.
const CANDIDATES = [
  path.resolve(UI, '..', '..', 'dist'),   // dev checkout: <root>/dist, from v3/build.ps1
  path.resolve(UI, '..', 'dist'),         // handoff repo: <repo>/dist, from src/build.ps1
  path.resolve(UI, '..', '..', 'v3', 'dist'),
];

function die(msg) {
  console.error('\nprepare-core: ' + msg + '\n');
  process.exit(1);
}

// Pick the most recently built core, not the first one found, and show the work.
// Printing only the winner is what made the shadowing invisible: the output looked
// exactly the same whichever tree it came from.
const found = CANDIDATES
  .map((d) => ({ dir: d, exe: path.join(d, 'tracey.exe') }))
  .filter((c) => fs.existsSync(c.exe))
  .map((c) => {
    const st = fs.statSync(c.exe);
    return Object.assign(c, { mtime: st.mtimeMs, size: st.size });
  })
  .sort((a, b) => b.mtime - a.mtime);

if (!found.length) {
  die('could not find a built tracey.exe. Looked in:\n  ' + CANDIDATES.join('\n  ') +
      '\nBuild the core first (ELEVATED PowerShell): cd v3 ; .\\build.ps1');
}

if (found.length > 1) {
  console.log('prepare-core: %d built cores found, using the newest:', found.length);
  found.forEach((c, i) => {
    console.log('  %s %s  %d bytes  %s',
      i === 0 ? 'USING ' : 'skip  ', new Date(c.mtime).toISOString(), c.size, c.exe);
  });
  const stale = Math.round((found[0].mtime - found[found.length - 1].mtime) / 86400000);
  if (stale >= 1) {
    console.log('prepare-core: NOTE the oldest is %d day(s) behind. If that is the one you', stale);
    console.log('              meant to ship, delete or rename the newer file and re-run.');
  }
}

const dir = found[0].dir;

const exe = path.join(dir, 'tracey.exe');
const cer = path.join(dir, 'TraceyDevSigning.cer');
if (!fs.existsSync(cer)) {
  die('found ' + exe + ' but no TraceyDevSigning.cer beside it.\n' +
      'Export it with:\n' +
      '  $c = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq "CN=Tracey Dev Signing" }\n' +
      '  Export-Certificate -Cert $c -FilePath "' + cer + '" -Type CERT');
}

// An unsigned core gets no uiAccess, so shipping one produces an installer that
// completes happily and filters nothing. Check before packaging, not after.
//
// The question is "is this file SIGNED", NOT "does this machine trust it". Those
// are different, and an earlier version of this check conflated them: it demanded
// Status == "Valid", which also requires the BUILD machine to trust the signer.
// The moment the certificate was pulled from LocalMachine\Root to test what a
// stranger's PC does, the status became UnknownError and this refused to package
// a perfectly good, properly signed core. Trust is the INSTALLER's job to
// establish on the target machine; the build only has to ship a signed binary.
// Rejected: NotSigned (no signature) and HashMismatch (tampered or truncated).
// Reported verbatim in the summary below. Hardcoding "signature Valid" there meant
// this script could warn that the status was UnknownError and then print "Valid" on
// the very next line, which is worse than printing nothing.
let sigStatus = 'not checked (non-Windows)';
if (process.platform === 'win32') {
  let status = 'unknown', signer = '';
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `$s = Get-AuthenticodeSignature ${JSON.stringify(exe)}; ` +
       '"$($s.Status)|$($s.SignerCertificate.Subject)"'],
      { encoding: 'utf8' }).trim();
    [status, signer] = out.split('|');
  } catch (e) {
    die('could not check the core signature: ' + e.message);
  }
  if (status === 'NotSigned' || status === 'HashMismatch' || !signer) {
    die(`the core at ${exe} has signature status "${status}" and signer "${signer}".\n` +
        'Windows will refuse to launch an unsigned uiAccess binary, so this ' +
        'installer would be dead on arrival. Re-run build.ps1.');
  }
  if (status !== 'Valid') {
    console.log(`prepare-core: NOTE signature is "${status}" on this machine - the core IS ` +
                `signed by ${signer}, this PC just does not trust that certificate right now. ` +
                'Packaging anyway; the installer establishes trust on the target machine.');
  }
  sigStatus = status;
}

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(exe, path.join(OUT, 'tracey.exe'));
fs.copyFileSync(cer, path.join(OUT, 'TraceyDevSigning.cer'));

console.log('prepare-core: staged from ' + dir);
console.log('  tracey.exe              ' + fs.statSync(path.join(OUT, 'tracey.exe')).size + ' bytes, signature ' + sigStatus);
console.log('  TraceyDevSigning.cer    ' + fs.statSync(path.join(OUT, 'TraceyDevSigning.cer')).size + ' bytes');
