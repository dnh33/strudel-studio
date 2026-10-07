// Validates that exported code (incl. embedded plugins) runs on the real strudel.cc REPL.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const code = fs.readFileSync(process.argv[2] ?? 'tests/.shots/export.js', 'utf8');
const bytes = new TextEncoder().encode(code);
let bin = '';
for (const b of bytes) bin += String.fromCharCode(b);
const url = 'https://strudel.cc/#' + encodeURIComponent(Buffer.from(bin, 'binary').toString('base64'));
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', `--proxy-server=${process.env.HTTPS_PROXY}`],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
await page.mouse.click(700, 450);
// press the play button (strudel.cc REPL header)
const play = page.locator('button', { hasText: /play/i }).first();
if (await play.count()) await play.click();
else await page.keyboard.press('Control+Enter');
await page.waitForTimeout(9000);
await page.screenshot({ path: 'tests/.shots/strudelcc.png' });
const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
const sounds = await page.evaluate(() => {
  const m = globalThis.soundMap?.get?.() ?? {};
  return ['triosc', 'superpad', 'fmkeys', 'sub808', 'pluck', 'drumsynth'].map((k) => k + ':' + (k in m));
});
console.log('plugin sounds registered on strudel.cc:', sounds.join(' '));
const errs = logs.filter((l) => /error/i.test(l) && !/favicon|Failed to load resource|net::/.test(l));
console.log('editor has code:', text.includes('Strudel Studio'));
console.log('logs (tail):\n ' + logs.slice(-25).join('\n '));
console.log('errors:', errs.length ? errs.join('\n') : 'none');
await browser.close();
