#!/usr/bin/env node
'use strict';
/**
 * Cross-layer consistency audit.
 *
 *   node tools/audit.js
 *
 * verify.js exercises behaviour through the mock core. This checks the seams
 * that no unit test can see, because they span two languages and three trees:
 *
 *   - the keys the C core writes into status.cfg vs the ones the UI parses,
 *     AND vs the ones the mock emits (a mock that has drifted means the whole
 *     suite is testing a contract the real core no longer speaks)
 *   - the keys the UI writes into config.cfg vs the ones the core parses
 *   - DOM ids app.js reaches for vs ids the markup defines
 *   - the preload surface vs the ipcMain handlers behind it, both directions
 *   - CSS rules for classes nothing uses any more
 *   - constants that must agree across C and JS (CAL_SECONDS), and libs the
 *     core needs to link at all
 *   - that every duplicated file is byte-identical across its copies
 *
 * Copy checks are skipped for trees that are not present, so this also runs
 * inside the public handoff repo where release/ and TraceyUI/ do not exist.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UI = path.resolve(__dirname, '..');
const HANDOFF = path.resolve(UI, '..');
const ROOT = path.resolve(HANDOFF, '..');

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

let problems = 0;
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { problems++; console.log('  FAIL  ' + m); };
const note = (m) => console.log('  note  ' + m);
const section = (m) => console.log('\n' + m);

const coreSrc = read(path.join(HANDOFF, 'src', 'tracey.c'));
const comms = read(path.join(UI, 'electron', 'core-comms.js'));
const mainJs = read(path.join(UI, 'electron', 'main.js'));
const preload = read(path.join(UI, 'electron', 'preload.js'));
const appJs = read(path.join(UI, 'renderer', 'app.js'));
const html = read(path.join(UI, 'renderer', 'index.html'));
const css = read(path.join(UI, 'renderer', 'styles.css'));
const mock = read(path.join(UI, 'tools', 'mock-core.js'));

section('status.cfg contract (core -> UI)');
{
  const m = /fprintf\(f,\s*"(running=[\s\S]*?)"\s*,/.exec(coreSrc.replace(/"\s*\n\s*"/g, ''));
  if (!m) bad('could not locate the status.cfg fprintf in tracey.c');
  else {
    // Split on the literal \n first, or \w+ swallows it and every key reads
    // back as "nenabled", "nfmin", ...
    const keys = m[1].split('\\n').map((s) => /^(\w+)=%/.exec(s.trim()))
      .filter(Boolean).map((x) => x[1]);
    ok('core writes: ' + keys.join(', '));
    for (const k of keys) {
      if (new RegExp('c\\.' + k + '\\b').test(comms)) ok(`UI parses ${k}`);
      else bad(`UI never parses status key "${k}"`);
      if (new RegExp('`' + k + '=|' + k + '=\\$\\{').test(mock)) ok(`mock emits ${k}`);
      else bad(`mock-core does not emit "${k}" — verify.js is testing a stale contract`);
    }
  }
}

section('config.cfg contract (UI -> core)');
{
  const keys = new Set(['enabled', 'fmin', 'beta']);
  if (/quit=1/.test(comms)) keys.add('quit');
  if (/calibrate=1/.test(comms)) keys.add('calibrate');
  ok('UI writes: ' + [...keys].join(', '));
  for (const k of keys) {
    if (new RegExp('"' + k + '=%').test(coreSrc)) ok(`core parses ${k}`);
    else bad(`core never parses config key "${k}"`);
  }
}

section('calpath.cfg contract (core -> UI)');
{
  if (/bounds=%d %d %d %d/.test(coreSrc)) ok('core writes a bounds header');
  else bad('core no longer writes the calpath bounds header');
  if (/startsWith\('bounds='\)/.test(comms)) ok('UI parses the bounds header');
  else bad('UI no longer parses the calpath bounds header');
  if (/MoveFileExW/.test(coreSrc)) ok('calpath is replaced atomically');
  else bad('calpath is rewritten in place — the UI can read a torn file');
}

section('DOM ids');
{
  const defined = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  for (const m of appJs.matchAll(/getElementById\('([\w-]+)'\)/g)) used.add(m[1]);
  let miss = 0;
  for (const u of used) if (!defined.has(u)) { bad(`app.js reaches for #${u}, absent from index.html`); miss++; }
  if (!miss) ok(`all ${used.size} ids used by app.js exist in the markup`);
  const refd = new Set([...html.matchAll(/(?:for|aria-labelledby|aria-describedby)="([\w\s-]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/)));
  const orphans = [...defined].filter((d) => !used.has(d) && !refd.has(d));
  // Some are reached through a variable (tag('tagPen', ...)) or a selector
  // (querySelectorAll('details')), which no static scan can see.
  if (orphans.length) note('ids not referenced literally (may be dynamic): ' + orphans.join(', '));
}

section('IPC surface');
{
  const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const channels = [...preload.matchAll(/invoke\('([\w:-]+)'/g)].map((m) => m[1]);
  const handled = new Set([...mainJs.matchAll(/ipcMain\.handle\('([\w:-]+)'/g)].map((m) => m[1]));
  for (const c of channels) {
    if (handled.has(c)) ok(`handler exists for ${c}`);
    else bad(`preload invokes "${c}" with no ipcMain.handle`);
  }
  for (const h of handled) if (!channels.includes(h)) bad(`ipcMain handles dead channel "${h}"`);
  for (const e of exposed) {
    if (!new RegExp('window\\.tracey\\.' + e + '\\b').test(appJs)) note(`tracey.${e} exposed but unused`);
  }
}

section('CSS');
{
  const declared = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const inHtml = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const inJs = new Set([
    ...[...appJs.matchAll(/className = '([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)),
    ...[...appJs.matchAll(/classList\.(?:add|remove|toggle)\('([\w-]+)'/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/className = '([^']*)' \+/g)].flatMap((m) => m[1].split(/\s+/)),
  ]);
  const used = new Set([...inHtml, ...inJs].filter(Boolean));
  const undeclared = [...used].filter((c) => !declared.has(c));
  if (undeclared.length) note('classes used with no rule: ' + undeclared.join(', '));
  else ok('every class used has a rule');
  for (const s of ['ghost', 'switch-row', 'miniswitch', 'group', 'scrollbar', 'preset', 'card']) {
    if (declared.has(s) && !used.has(s)) bad(`.${s} has rules but nothing uses it (stale CSS)`);
  }
  // The list above only ever covered seven names, so a class deleted from the
  // markup kept its rules silently -- which is exactly how .blocker's styles
  // outlived the element. Everything else is reported, but as a note: some
  // classes are only ever applied through a variable, which no static scan sees.
  // Scan SELECTORS only, from comment-stripped CSS: a bare `.name` regex over the
  // whole file also matches inside data: URIs (`www.w3.org`) and comments, which
  // reports classes that were never declared at all.
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|[};])\s*([^{};]+)\{/g)]
    .map((m) => m[2]);
  const declaredSel = new Set(selectors.flatMap(
    (s) => [...s.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])));
  // Anything named anywhere in app.js counts as used: several classes are applied
  // through a variable (tag() passes 'ok'/'bad'/'warn'), which no scan can follow.
  const named = new Set([...appJs.matchAll(/'([a-zA-Z][\w-]*)'/g)].map((m) => m[1]));
  const orphanRules = [...declaredSel].filter((c) => !used.has(c) && !named.has(c)).sort();
  if (orphanRules.length) bad('rules whose class nothing uses (stale CSS): ' + orphanRules.join(', '));
  else ok('no stale class rules');
}

/* An element hidden with `el.hidden = true` relies on the UA stylesheet's
 * `[hidden] { display: none }`, and ANY author `display` declaration beats a UA
 * rule regardless of specificity. That is silent: the attribute is set, the
 * element stays on screen. It cost both pads' prompts once already -- the fix is
 * a paired `.thing[hidden] { display: none }` -- so it is checked, not remembered. */
section('hidden-toggled elements vs author display rules');
{
  const hiddenIds = new Set([
    ...[...appJs.matchAll(/\$\('([\w-]+)'\)\.hidden\s*=/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/getElementById\('([\w-]+)'\)\.hidden\s*=/g)].map((m) => m[1]),
    ...[...html.matchAll(/\bid="([\w-]+)"[^>]*\shidden\b/g)].map((m) => m[1]),
  ]);
  const classesOf = (id) => {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
    const cls = tag && tag[0].match(/class="([^"]+)"/);
    return cls ? cls[1].split(/\s+/).filter(Boolean) : [];
  };
  // Rule blocks, comments stripped. Matching `.cls { ... }` anchored to the
  // preceding character does NOT work: a rule introduced by a comment has `/`
  // in front of it and silently fails to match, which makes the whole check
  // pass vacuously. Collect every block instead, then test its selector list.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1], body: m[2] }));
  // "Plain" = the class carries a display OUTSIDE any [hidden] guard.
  const hasPlainDisplay = (c) => rules.some((r) =>
    new RegExp(`\\.${c}(?![\\w-])(?!\\[hidden\\])`).test(r.sel) && /display\s*:/.test(r.body));
  let risky = 0;
  for (const id of [...hiddenIds].sort()) {
    for (const c of classesOf(id)) {
      if (!hasPlainDisplay(c)) continue;
      if (new RegExp(`\\.${c}\\[hidden\\]`).test(css)) continue;
      bad(`#${id} is toggled with .hidden but .${c} sets display and has no .${c}[hidden] rule`);
      risky++;
    }
  }
  if (!risky) ok(`all ${hiddenIds.size} hidden-toggled elements survive the [hidden] attribute`);
}

section('cross-language constants');
{
  const cal = /#define CAL_SECONDS\s+(\d+)/.exec(coreSrc);
  const js = /const CAL_SECONDS = (\d+)/.exec(appJs);
  if (cal && js && cal[1] === js[1]) ok(`CAL_SECONDS agrees (${cal[1]})`);
  else bad(`CAL_SECONDS mismatch: core=${cal && cal[1]} app.js=${js && js[1]}`);

  const build = path.join(HANDOFF, 'src', 'build.ps1');
  if (exists(build)) {
    const b = read(build);
    for (const lib of ['user32.lib', 'setupapi.lib', 'cfgmgr32.lib']) {
      if (b.includes(lib)) ok(`build.ps1 links ${lib}`);
      else bad(`build.ps1 does not link ${lib} — the core will not build`);
    }
  }
}

section('duplicate files');
{
  const uiFiles = ['electron/core-comms.js', 'electron/main.js', 'electron/preload.js',
                   'renderer/app.js', 'renderer/index.html', 'renderer/styles.css', 'renderer/oneeuro.js'];
  // Two trees now, not three. release\Tracey was a hand-made unpacked build that
  // served as "the shipping UI" before there was an installer; electron-builder
  // now produces the shipping UI from THIS tree, so keeping that copy in sync
  // bought nothing and cost a third place to forget. Deleted 2026-07-28.
  // filter(exists) means this list degrades safely either way.
  const uiCopies = [UI, path.join(ROOT, 'TraceyUI', 'tracey-ui')].filter(exists);
  if (uiCopies.length === 1) note('only one UI tree present — copy check skipped');
  else for (const f of uiFiles) {
    const hs = uiCopies.map((c) => (exists(path.join(c, f)) ? md5(path.join(c, f)) : 'MISSING'));
    if (new Set(hs).size === 1) ok(`${uiCopies.length} copies identical: ${f}`);
    else bad(`UI copies differ: ${f} -> ${hs.join(' ')}`);
  }

  const cores = ['v1/tracey.c', 'v2/tracey.c', 'v3/tracey.c']
    .map((c) => path.join(ROOT, c)).filter(exists)
    .concat([path.join(HANDOFF, 'src', 'tracey.c')]);
  if (cores.length === 1) note('only one core copy present — copy check skipped');
  else {
    const hs = cores.map(md5);
    if (new Set(hs).size === 1) ok(`${cores.length} copies identical: tracey.c`);
    else bad('core copies differ: ' + hs.join(' '));
  }
}

console.log(problems ? `\n${problems} PROBLEM(S)` : '\nclean — no problems found');
process.exit(problems ? 1 : 0);
