// Browser test of the web app against two emulated receivers (emulator.js).
// Usage: node webapp/tests/e2e/e2e.cjs [screenshot-dir]
// Needs Playwright with Chromium (require('playwright')).
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  const shots = process.argv[2];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  let failed = false;
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failed = true;
  };
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: shots ? 2 : 1, colorScheme: scheme });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.addInitScript({ path: path.join(__dirname, 'emulator.js') });
      await page.goto(base + '/index.html');
      for (const n of ['A', 'B']) {
        await page.click('#connect-' + n);
        await page.waitForFunction((n) => document.getElementById('status-' + n).textContent.includes('C3'), n);
      }
      check((await page.inputValue('#trigger-mode')) === 'gpio', `${scheme}: GPIO trigger selected`);
      await page.click('#run');
      await page.waitForFunction(() => Number(document.getElementById('m-count').textContent) >= 30, null, { timeout: 60000 });
      await page.click('#run');
      await page.waitForFunction(() => document.getElementById('message').textContent === 'Stopped.');
      const dphi = parseFloat(await page.textContent('#m-dphi'));
      const lag = parseFloat(await page.textContent('#m-lag'));
      check(Math.abs(dphi - 34.4) < 3, `${scheme}: mean dphi ${dphi}° (expected 34.4°)`);
      check(Math.abs(lag + 3) < 0.2, `${scheme}: time offset ${lag} samples (expected -3)`);
      check((await page.textContent('#warnings')) === '', `${scheme}: no warnings`);
      if (scheme === 'light') {
        await page.evaluate(() => (window.__emu.wireConnected = false));
        await page.click('#capture');
        await page.waitForFunction(() => document.getElementById('message').classList.contains('error'), null, { timeout: 15000 });
        check((await page.textContent('#message')).includes('trigger_timeout'), 'disconnected wire reported');
        await page.evaluate(() => (window.__emu.wireConnected = true));
        await page.click('#capture');
        await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Captured'), null, { timeout: 15000 });
        check(true, 'recovers after the error');
        const before = await page.evaluate(() => window.__emu.requests);
        await page.click('#disconnect-B');
        await page.click('#connect-B');
        await page.waitForFunction(() => document.getElementById('status-B').textContent.includes('Web Serial'));
        check((await page.evaluate(() => window.__emu.requests)) === before, 'web serial: reconnect without chooser');
      }
      if (shots) await page.screenshot({ path: path.join(shots, `webapp-correlator-${scheme}.png`), fullPage: true });
      check(!errors.length, `${scheme}: no console errors ${errors.join(' ')}`);
      await page.close();
    }
    // WebUSB: the second Connect reuses the granted device (no chooser), also
    // after a reload, and Swap exchanges the roles.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.addInitScript({ path: path.join(__dirname, 'emulator.js') });
      await page.goto(base + '/index.html');
      const status = (n) => page.textContent('#status-' + n);
      const requests = () => page.evaluate(() => window.__emu.requests);
      const connectBoth = async () => {
        for (const n of ['A', 'B']) {
          await page.selectOption('#iface-' + n, 'webusb');
          await page.click('#connect-' + n);
          await page.waitForFunction((n) => document.getElementById('status-' + n).textContent.includes('WebUSB'), n);
        }
      };
      await connectBoth();
      check((await status('A')).includes('EMU:A') && (await status('B')).includes('EMU:B'), 'webusb: both receivers connected');
      check((await requests()) === 2, 'webusb: one chooser per receiver');
      await page.click('#capture');
      await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Captured'), null, { timeout: 15000 });
      check(Math.abs(parseFloat(await page.textContent('#m-lag')) + 3) < 0.2, 'webusb: capture over native USB');
      await page.click('#disconnect-A');
      await page.click('#connect-A');
      await page.waitForFunction(() => document.getElementById('status-A').textContent.includes('EMU:A'));
      check((await requests()) === 2, 'webusb: reconnect without chooser');
      await page.click('#swap');
      check((await status('A')).includes('EMU:B') && (await status('B')).includes('EMU:A'), 'webusb: swap exchanges the roles');
      await page.reload();
      await page.evaluate(() => window.__emu.restore([], [0, 1]));
      check((await page.inputValue('#iface-A')) === 'webusb', 'webusb: interface remembered');
      for (const n of ['A', 'B']) {
        await page.click('#connect-' + n);
        await page.waitForFunction((n) => document.getElementById('status-' + n).textContent.includes('WebUSB'), n);
      }
      check((await requests()) === 0, 'webusb: after reload, connect without chooser');
      check((await status('A')).includes('EMU:B'), 'webusb: swapped roles remembered');
      check(!errors.length, `webusb: no console errors ${errors.join(' ')}`);
      await page.close();
    }
    const f = await browser.newPage();
    await f.goto(base + '/flash.html');
    await f.waitForFunction(() => document.querySelectorAll('#revision option').length > 1, null, { timeout: 10000 });
    check(true, 'flasher lists the ESP32-C3 firmware');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
})();
