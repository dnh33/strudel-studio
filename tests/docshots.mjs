// Captures documentation screenshots at 1920x1080.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const PORT = 4181;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required', `--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.studioEngine?.status === 'ready', null, { timeout: 90000 });
await page.mouse.click(1000, 1060);
const D = (fn, arg) => page.evaluate(fn, arg);
// song mode
await page.click('.seg.mode button:nth-child(2)');
await D(() => window.__studioDebug.useStudio.setState({ startBar: 12 }));
await page.keyboard.press('Space');
await page.waitForTimeout(5000);
await page.screenshot({ path: 'docs/screenshots/song-mode.png' });
// piano roll on the lead
await D(() => {
  const s = window.__studioDebug.getState();
  const lead = s.project.channels.find((c) => c.name === 'Lead');
  const pat = s.project.patterns.find((p) => p.name === 'Lead');
  window.__studioDebug.useStudio.setState({ channelId: lead.id, patternId: pat.id });
  s.moveWindow('pianoRoll', { x: 60, y: 90, w: 1500, h: 620 });
  s.openWindow('pianoRoll');
});
await page.waitForTimeout(2500);
await page.screenshot({ path: 'docs/screenshots/piano-roll.png' });
await D(() => window.__studioDebug.getState().openWindow('pianoRoll', false));
// mixer
await D(() => {
  const s = window.__studioDebug.getState();
  window.__studioDebug.useStudio.setState({ selectedInsert: 4 });
  s.moveWindow('mixer', { x: 40, y: 300, w: 1560, h: 470 });
  s.openWindow('mixer');
});
await page.waitForTimeout(2500);
await page.screenshot({ path: 'docs/screenshots/mixer.png' });
await page.keyboard.press('Space');
await D(() => window.__studioDebug.getState().openWindow('mixer', false));
// plugin lab
await D(() => {
  const s = window.__studioDebug.getState();
  s.moveWindow('pluginLab', { x: 80, y: 60, w: 1400, h: 760 });
  s.openWindow('pluginLab');
});
await page.waitForTimeout(500);
await page.click('.lab-item:has-text("3xOsc")');
await page.click('text=Test (render)');
await page.waitForFunction(() => document.querySelector('.lab-status')?.textContent?.includes('OK'), null, { timeout: 30000 });
await page.screenshot({ path: 'docs/screenshots/plugin-lab.png' });
await browser.close();
server.kill();
console.log('screenshots done');
process.exit(0);
