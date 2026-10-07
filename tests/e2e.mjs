// End-to-end test in headless Chromium: loads the built app, plays audio, renders WAVs, drives the UI.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const OUT = process.env.SHOTS ?? 'tests/.shots';
fs.mkdirSync(OUT, { recursive: true });
const PORT = 4179;
const server = spawn('npx', ['vite', 'preview', '--outDir', 'app', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--autoplay-policy=no-user-gesture-required', `--proxy-server=${process.env.HTTPS_PROXY ?? ''}`, '--proxy-bypass-list=localhost;127.0.0.1'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 8).join('\n')));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

let failures = 0;
const ok = (c, msg) => {
  console.log((c ? '  ok   ' : '  FAIL ') + msg);
  if (!c) failures++;
};
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.studioEngine?.status === 'ready' || window.studioEngine?.status === 'failed', null, { timeout: 90000 });
ok(await page.evaluate(() => window.studioEngine.status) === 'ready', 'engine ready');
await page.mouse.click(800, 500); // user gesture
await page.waitForTimeout(500);
await shot('01-start');

// ---- play pattern mode
await page.keyboard.press('Space');
await page.waitForTimeout(4000);
const st = await page.evaluate(() => ({
  playing: window.studioEngine.playing,
  pos: window.studioEngine.position(),
  ctx: window.studioEngine.ctx.state,
  err: window.studioEngine.lastError,
  triggers: window.studioEngine.recentTriggers(10).length,
}));
console.log('  state', JSON.stringify(st));
ok(st.playing && st.pos !== null, 'playing in pattern mode');
ok(!st.err, 'no eval error: ' + st.err);
const peak = await page.evaluate(async () => {
  let m = 0;
  for (let i = 0; i < 20; i++) {
    const x = window.studioEngine.meter(0);
    if (x) m = Math.max(m, x.l.peak, x.r.peak);
    await new Promise((r) => setTimeout(r, 50));
  }
  return m;
});
ok(peak > 0.01, `master meter shows signal (peak ${peak.toFixed(3)})`);
await shot('02-playing-pattern');

// ---- song mode
await page.click('.seg.mode button:nth-child(2)');
await page.waitForTimeout(3000);
const song = await page.evaluate(() => ({ pos: window.studioEngine.position(), err: window.studioEngine.lastError, mode: window.studioEngine.getTransport().mode }));
console.log('  song', JSON.stringify(song));
ok(song.mode === 'song' && song.pos > 0, 'song mode playing');
await shot('03-song-mode');
await page.keyboard.press('Space');
await page.waitForTimeout(300);
ok(await page.evaluate(() => !window.studioEngine.playing), 'stopped');

// ---- offline render of the song (4 bars)
const render = await page.evaluate(async () => {
  const { compileProject } = window.__studioDebug;
  const s = window.__studioDebug.getState();
  const code = window.__studioDebug.compileCurrent({ ...s, mode: 'song' }).code;
  const buf = await window.studioEngine.renderBuffer({ code, project: s.project, startBar: 8, bars: 4, tailSeconds: 1 });
  let peak = 0, sum = 0;
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; }
  return { dur: buf.duration, peak, rms: Math.sqrt(sum / d.length) };
});
console.log('  render', JSON.stringify(render));
ok(render.peak > 0.05 && render.rms > 0.005, 'offline song render has audio');
ok(render.peak <= 0.945, `master limiter keeps peaks under the -0.5 dB ceiling (${render.peak.toFixed(3)})`);

// ---- every plugin renders sound offline
const plugins = await page.evaluate(async () => {
  const out = {};
  const ids = ['triosc', 'superpad', 'fmkeys', 'chipboy', 'sub808', 'pluck', 'drumsynth'];
  const s = window.__studioDebug.getState();
  for (const id of ids) {
    try {
      const buf = await window.studioEngine.renderBuffer({ code: `setcpm(30)\n$: note("c3 e3 g3 c4").s("${id}").orbit(0)`, project: s.project, startBar: 0, bars: 1, tailSeconds: 1 });
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
      out[id] = peak;
    } catch (e) { out[id] = 'ERR ' + e.message; }
  }
  return out;
});
for (const [id, p] of Object.entries(plugins)) ok(typeof p === 'number' && p > 0.01, `plugin ${id} renders (peak ${typeof p === 'number' ? p.toFixed(3) : p})`);

// ---- plays again after rendering (realtime context restored)
await page.keyboard.press('Space');
await page.waitForTimeout(2500);
ok(await page.evaluate(() => window.studioEngine.playing && window.studioEngine.position() > 0), 'realtime playback works after offline render');
await page.keyboard.press('Space');

// ---- UI: channel rack step toggle
await page.click('.seg.mode button:nth-child(1)');
const before = await page.evaluate(() => JSON.stringify(window.__studioDebug.getState().project.patterns[0].steps));
const step = page.locator('.rack-row').first().locator('.step').nth(2);
await step.click();
const after = await page.evaluate(() => JSON.stringify(window.__studioDebug.getState().project.patterns[0].steps));
ok(before !== after, 'clicking a step changes the pattern');
await page.keyboard.press('Control+z');
const undone = await page.evaluate(() => JSON.stringify(window.__studioDebug.getState().project.patterns[0].steps));
ok(undone === before, 'undo restores the step');

// ---- piano roll
await page.evaluate(() => {
  const s = window.__studioDebug.getState();
  const bass = s.project.channels.find((c) => c.name === 'Bass');
  const pat = s.project.patterns.find((p) => p.name === 'Bassline');
  window.__studioDebug.useStudio.setState({ channelId: bass.id, patternId: pat.id });
  s.openWindow('pianoRoll');
});
await page.waitForTimeout(400);
await shot('04-piano-roll');
const nBefore = await page.evaluate(() => { const s = window.__studioDebug.getState(); return s.project.patterns.find((p) => p.id === s.patternId).notes[s.channelId].length; });
const gb = await page.locator('.pr-scroll').boundingBox();
await page.mouse.click(gb.x + 300, gb.y + 40);
const nAfter = await page.evaluate(() => { const s = window.__studioDebug.getState(); return s.project.patterns.find((p) => p.id === s.patternId).notes[s.channelId].length; });
ok(nAfter === nBefore + 1, `piano roll click adds a note (${nBefore} -> ${nAfter})`);

// ---- mixer
await page.keyboard.press('F9');
await page.waitForTimeout(300);
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
await shot('05-mixer');
await page.keyboard.press('Space');

// ---- plugin lab
await page.keyboard.press('F8');
await page.waitForTimeout(500);
await shot('06-plugin-lab');
await page.click('.lab-item.new');
await page.click('text=Test (render)');
await page.waitForFunction(() => document.querySelector('.lab-status')?.textContent?.length > 5, null, { timeout: 30000 });
const labStatus = await page.locator('.lab-status').textContent();
console.log('  lab:', labStatus.slice(0, 120));
ok(/render OK/.test(labStatus), 'Plugin Lab template installs and renders');
await shot('07-plugin-lab-tested');

// ---- channel settings + automation window
await page.keyboard.press('F8');
await page.evaluate(() => {
  const s = window.__studioDebug.getState();
  const ch = s.project.channels.find((c) => c.name === 'Chords');
  window.__studioDebug.useStudio.setState({ settingsChannelId: ch.id });
  s.openWindow('channelSettings');
  const clip = s.project.clips.find((c) => c.kind === 'automation');
  window.__studioDebug.useStudio.setState({ automationClipId: clip.id });
  s.openWindow('automation');
});
await page.waitForTimeout(500);
await shot('08-settings-automation');

// ---- live code mode
await page.evaluate(() => { const s = window.__studioDebug.getState(); s.openWindow('code'); });
const liveCode = await page.evaluate(() => {
  const s = window.__studioDebug.getState();
  const r = window.__studioDebug.compileCurrent({ ...s, mode: 'live' });
  const kick = s.project.channels.find((c) => c.name === 'Kick');
  const beat = s.project.patterns.find((p) => p.name === 'Beat');
  return `$: s("hh*8").bank("RolandTR909").gain(.4)\n$: ${r.channelIdents[kick.id]}(${r.patternIdents[beat.id]}.${r.channelIdents[kick.id]}).fast(2)`;
});
console.log('  live code:', JSON.stringify(liveCode));
await page.evaluate((c) => window.__studioDebug.runLiveCode(c), liveCode);
await page.waitForTimeout(2000);
const live = await page.evaluate(() => ({ playing: window.studioEngine.playing, err: window.studioEngine.lastError, code: window.studioEngine.lastEvaluated.code.slice(-80) }));
console.log('  live', JSON.stringify(live));
ok(live.playing && !live.err, 'live code plays and can reference project instruments');
await page.keyboard.press('Space');

// ---- export dialog (WAV via UI), mid-length
await page.keyboard.press('Control+r');
await page.waitForTimeout(300);
await shot('09-export-dialog');
await page.keyboard.press('Escape');


// ---- performance: compile + hot-swap evaluation while playing the song
await page.click('.seg.mode button:nth-child(2)');
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const perf = await page.evaluate(async () => {
  const D = window.__studioDebug;
  const s = D.getState();
  const t0 = performance.now();
  const res = D.compileProject(s.project, { mode: 'song', patternId: s.patternId });
  const t1 = performance.now();
  await window.studioEngine.update(res.code + '\n', true);
  const t2 = performance.now();
  return { compileMs: t1 - t0, evalMs: t2 - t1, lines: res.code.split('\n').length };
});
console.log('  perf', JSON.stringify(perf));
ok(perf.compileMs < 50 && perf.evalMs < 250, 'compile + hot-swap is fast');

// ---- loop region keeps the playhead inside [8, 10)
await page.evaluate(() => window.__studioDebug.useStudio.setState({ loop: { start: 8, end: 10 }, startBar: 8 }));
await page.waitForTimeout(300);
await page.evaluate(() => window.__studioEngine?.restart?.());
const loopPos = [];
for (let i = 0; i < 8; i++) {
  loopPos.push(await page.evaluate(() => window.studioEngine.position()));
  await page.waitForTimeout(500);
}
console.log('  loop positions', loopPos.map((x) => x?.toFixed(2)).join(' '));
ok(loopPos.every((x) => x !== null && x >= 8 && x < 10), 'loop region is respected');
await page.evaluate(() => window.__studioDebug.useStudio.setState({ loop: null, startBar: 0 }));
await page.keyboard.press('Space');

// ---- recording from the typing keyboard into the piano roll (pattern mode)
await page.evaluate(() => {
  const D = window.__studioDebug;
  const s = D.getState();
  const lead = s.project.channels.find((c) => c.name === 'Lead');
  const pat = s.project.patterns.find((p) => p.name === 'Lead');
  D.useStudio.setState({ channelId: lead.id, patternId: pat.id, recording: true, mode: 'pattern' });
});
await page.mouse.click(5, 940); // focus body (hint bar)
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const recBefore = await page.evaluate(() => { const s = window.__studioDebug.getState(); return s.project.patterns.find((p) => p.id === s.patternId).notes[s.channelId].length; });
for (const k of ['q', 'w', 'e']) {
  await page.keyboard.down(k);
  await page.waitForTimeout(180);
  await page.keyboard.up(k);
  await page.waitForTimeout(120);
}
const recAfter = await page.evaluate(() => { const s = window.__studioDebug.getState(); return s.project.patterns.find((p) => p.id === s.patternId).notes[s.channelId].length; });
ok(recAfter === recBefore + 3, `typing keyboard recording adds notes (${recBefore} -> ${recAfter})`);
await page.keyboard.press('Space');
await page.evaluate(() => window.__studioDebug.useStudio.setState({ recording: false }));

// ---- WAV export through the dialog
await page.keyboard.press('Control+r');
await page.waitForTimeout(300);
await page.click('.export .seg button:nth-child(2)'); // pattern
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('text=Render WAV')]);
const wavPath = `${OUT}/export.wav`;
await dl.saveAs(wavPath);
const wav = fs.readFileSync(wavPath);
ok(wav.slice(0, 4).toString() === 'RIFF' && wav.length > 100000, `WAV export downloaded (${wav.length} bytes, ${dl.suggestedFilename()})`);
const [mid] = await Promise.all([page.waitForEvent('download'), page.click('text=MIDI (.mid)')]);
const midPath = `${OUT}/export.mid`;
await mid.saveAs(midPath);
ok(fs.readFileSync(midPath).slice(0, 4).toString() === 'MThd', 'MIDI export is a valid SMF');
const [js] = await Promise.all([page.waitForEvent('download'), page.click('text=Strudel code (.js)')]);
const jsPath = `${OUT}/export.js`;
await js.saveAs(jsPath);
ok(/definePlugin/.test(fs.readFileSync(jsPath, 'utf8')), 'code export embeds plugins');
await page.keyboard.press('Escape');

// ---- save project file & load it back
const [pj] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
const pjPath = `${OUT}/project.json`;
await pj.saveAs(pjPath);
const saved = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
ok(saved.format === 'strudel-studio' && saved.channels.length === 8, 'project file saved');
await page.evaluate(() => window.__studioDebug.getState().loadProject({ format: 'strudel-studio', version: 1, name: 'Empty' }));
ok(await page.evaluate(() => window.__studioDebug.getState().project.channels.length === 0), 'empty project loaded');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
await chooser.setFiles(pjPath);
await page.waitForTimeout(500);
ok(await page.evaluate(() => window.__studioDebug.getState().project.channels.length === 8), 'project file re-opened');

// ---- import a user sample (generated sine wav)
const sr = 22050, n = sr / 2;
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / sr) * 2 * Math.PI * 440) * 12000 * (1 - i / n)), 44 + i * 2);
fs.writeFileSync(`${OUT}/My Tone.wav`, buf);
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=+ Import samples')]);
await fc.setFiles(`${OUT}/My Tone.wav`);
await page.waitForTimeout(800);
ok(await page.evaluate(() => window.studioEngine.userSamples.some((u) => u.name === 'my_tone') && window.studioEngine.hasSound('my_tone')), 'user sample imported & registered');
const userRender = await page.evaluate(async () => {
  const s = window.__studioDebug.getState();
  const b = await window.studioEngine.renderBuffer({ code: 'setcpm(60)\n$: s("my_tone").orbit(0)', project: s.project, startBar: 0, bars: 1, tailSeconds: 0.2 });
  let p = 0; const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  return p;
});
ok(userRender > 0.05, `user sample renders (peak ${userRender.toFixed(3)})`);


// ---- code channel with a syntax error is reported and skipped, playback continues
await page.evaluate(() => {
  const D = window.__studioDebug;
  const s = D.getState();
  const sp = s.project.channels.find((c) => c.name === 'Sparkle');
  s.update((p) => { p.channels.find((c) => c.id === sp.id).code = 'n("0 2".scale('; });
});
await page.waitForTimeout(1500);
const codeErr = await page.evaluate(() => { const s = window.__studioDebug.getState(); return Object.values(s.codeErrors)[0] ?? null; });
ok(!!codeErr, 'broken code channel is detected: ' + String(codeErr).slice(0, 60));
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
ok(await page.evaluate(() => window.studioEngine.playing && !window.studioEngine.lastError), 'project still plays with a broken code channel');
await page.keyboard.press('Space');
await page.evaluate(() => window.__studioDebug.getState().undo());

// ---- browser: search + double-click adds a channel
const nCh = await page.evaluate(() => window.__studioDebug.getState().project.channels.length);
await page.fill('.browser-search', '808 clap');
await page.waitForTimeout(300);
await page.locator('.lib-item').first().dblclick();
await page.waitForTimeout(300);
const added = await page.evaluate(() => { const c = window.__studioDebug.getState().project.channels; return { n: c.length, last: c[c.length - 1] }; });
ok(added.n === nCh + 1 && added.last.bank === 'RolandTR808' && added.last.sound === 'cp', `browser double-click adds ${added.last?.bank} ${added.last?.sound}`);
await page.fill('.browser-search', '');

// ---- full HD layout screenshot with the demo reloaded
await page.setViewportSize({ width: 1920, height: 1080 });
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForFunction(() => window.studioEngine?.status === 'ready', null, { timeout: 90000 });
await page.mouse.click(900, 600);
await page.click('.seg.mode button:nth-child(2)');
await page.keyboard.press('Space');
await page.waitForTimeout(3500);
await shot('10-fullhd-song');
await page.keyboard.press('Space');

// a VST3 channel (native app) opened in the browser plays a stand-in synth
const vst = await page.evaluate(async () => {
  const D = window.__studioDebug;
  const id = D.actions.addVstChannel({ id: 'VST3-Some Synth-1-2', name: 'Some Synth', vendor: 'X' });
  const s = D.getState();
  D.actions.setNotes(s.patternId, id, [{ id: 'v1', key: 60, start: 0, len: 96, vel: 1 }]);
  const st = D.getState();
  const code = D.compileCurrent({ ...st, mode: 'pattern' }).code;
  const buf = await window.studioEngine.renderBuffer({ code: `setcpm(30)\n$: note("c3 e3").s("native").vst('${id}').orbit(0)`, project: st.project, startBar: 0, bars: 1, tailSeconds: 0.5 });
  let pk = 0;
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  D.actions.deleteChannel(id);
  return { native: D.nativeBridge.isNative, compiled: code.includes(`.s("native").vst('${id}')`), pk };
});
ok(!vst.native && vst.compiled && vst.pk > 0.01, `VST3 channel in the browser: compiles to .s("native") and plays a stand-in (peak ${vst.pk.toFixed(3)})`);

ok(errors.filter((e) => !/favicon|net::ERR|Failed to load resource/.test(e)).length === 0, 'no page errors');
if (errors.length) console.log('  errors:\n   ' + errors.slice(0, 20).join('\n   '));
await browser.close();
server.kill();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E PASSED');
process.exit(failures ? 1 : 0);
