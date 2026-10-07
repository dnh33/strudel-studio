import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const server = spawn('npx', ['vite', '--port', '5188', '--strictPort'], { stdio: 'pipe' });
let out = '';
server.stdout.on('data', (d) => (out += d));
server.stderr.on('data', (d) => (out += d));
await new Promise((r) => setTimeout(r, 4000));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required', `--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5188/');
await page.waitForFunction(() => window.studioEngine?.status === 'ready', null, { timeout: 120000 });
const patched = await page.evaluate(async () => {
  // offline render exercises the patched node pool
  const s = window.__studioDebug.getState();
  const code = window.__studioDebug.compileCurrent({ ...s, mode: 'song' }).code;
  const b = await window.studioEngine.renderBuffer({ code, project: s.project, startBar: 0, bars: 2, tailSeconds: 0.5 });
  return b.duration;
});
console.log('dev render ok, seconds:', patched.toFixed(2), 'errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
process.exit(0);
