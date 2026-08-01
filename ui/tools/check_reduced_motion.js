/* Does prefers-reduced-motion actually stop every animation?
 *
 *   npm run check-motion            expect PASS, exit 0
 *   npm run check-motion -- --control   expect the probe to SEE motion, exit 0
 *
 * Why this exists: ACCESSIBILITY.md promises that every animation is disabled
 * under reduced motion, and styles.css used to say `* { animation: none }`. A
 * bare universal selector does NOT match ::before or ::after, so animations
 * declared on pseudo-elements kept running, including the selected-preset
 * checkmark's overshooting bounce. No other gate can see this: verify.js never
 * renders anything and audit.js only greps for class names, so a stylesheet can
 * claim one thing and compute another with both green.
 *
 * It runs in the app's own Electron, so the engine under test is the engine that
 * ships, and it turns reduced motion on through CDP rather than depending on the
 * machine's accessibility settings.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const CONTROL = process.argv.includes('--control');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadFile(path.join(__dirname, 'reduced-motion-page.html'));

  if (!CONTROL) {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  const out = await win.webContents.executeJavaScript(`(() => {
    const q = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    const rows = [
      ['element .preset          animation',  q('.preset', null).animationName],
      ['pseudo  .preset::after   animation',  q('.preset', '::after').animationName],
      ['pseudo  .knob::before    transition', q('.knob', '::before').transitionDuration],
      ['pseudo  .knob::after     transition', q('.knob', '::after').transitionDuration],
      ['pseudo  summary::before  transition', q('.advanced summary', '::before').transitionDuration],
    ];
    const zero = (v) => v === 'none' || v === '' || parseFloat(v) === 0;
    return {
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      rows,
      live: rows.filter(r => !zero(r[1])).map(r => r[0].trim()),
    };
  })()`);

  console.log('prefers-reduced-motion active:', out.reduced);
  for (const [label, value] of out.rows) console.log('   ', label.padEnd(38), '=', value);

  if (CONTROL) {
    // Without emulation the animations MUST still be live. If they are not, the
    // probe is blind and a PASS in the real run would mean nothing.
    const ok = out.live.length > 0;
    console.log('\ncontrol run, no emulation:', ok
      ? 'OK, ' + out.live.length + ' still animating, so the probe can see motion'
      : 'BROKEN, nothing animating even without emulation');
    app.exit(ok ? 0 : 1);
  } else {
    console.log('\n' + (out.live.length
      ? 'FAIL, still animating under reduced motion: ' + out.live.join(', ')
      : 'PASS, every listed animation and transition is off'));
    app.exit(out.live.length ? 1 : 0);
  }
});
