// Node test: compiles demo projects and evaluates the generated code with the real Strudel engine.
import { execSync } from 'node:child_process';
execSync('node tests/build.mjs', { stdio: 'inherit' });
const M = await import('./.build/model.mjs?' + Date.now());
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

const registered = new Map();
const registerSound = (name, fn, data) => registered.set(name, { fn, data });
const getAudioContext = () => ({ sampleRate: 48000, audioWorklet: { addModule: async () => {} } });
await core.evalScope(core, mini, tonal, { registerSound, getAudioContext });
mini.miniAllStrings();
M.initPlugins({ registerSound, registerControl: core.registerControl, getAudioContext });
ok(M.getInstalledPlugins().length >= 7, `stock plugins installed (${M.getInstalledPlugins().map(p=>p.id).join(', ')})`);

const r = core.repl({ defaultOutput: () => {}, getTime: () => 0, transpiler });
async function evalCode(code, label) {
  const pat = await r.evaluate(code, false);
  if (r.state.evalError) { console.log(code.split('\n').map((l,i)=>`${i+1}: ${l}`).join('\n')); }
  ok(!r.state.evalError, `${label} evaluates` + (r.state.evalError ? ': ' + r.state.evalError.message : ''));
  return pat;
}
const onsets = (pat, a, b) => pat.queryArc(a, b).filter((h) => h.hasOnset());

for (const demo of M.DEMOS) {
  console.log(`\n== ${demo.name}`);
  const p = demo.make();
  const getPlugin = M.getPluginInfo;
  const allPluginIds = M.getInstalledPlugins().map((x) => x.id);
  // pattern mode
  for (const pt of p.patterns) {
    const res = M.compileProject(p, { mode: 'pattern', patternId: pt.id, getPlugin });
    const pat = await evalCode(res.code, `pattern "${pt.name}"`);
    if (pat) {
      const hs = onsets(pat, 0, pt.bars);
      ok(hs.length > 0 || Object.keys(pt.code).length > 0, `pattern "${pt.name}" produces ${hs.length} events`);
    }
  }
  // song mode
  const song = M.compileProject(p, { mode: 'song', getPlugin });
  if (demo.id === 'house') console.log(song.code);
  const spat = await evalCode(song.code, 'song');
  ok(Math.abs(r.scheduler.cps - p.bpm / p.beatsPerBar / 60) < 1e-9, `cps = ${r.scheduler.cps}`);
  const all = onsets(spat, 0, song.songBars);
  ok(all.length > 100, `song has ${all.length} events over ${song.songBars} bars`);
  // every event must carry a known channel color + an orbit
  const colors = new Set(p.channels.map((c) => c.color));
  ok(all.every((h) => colors.has(h.value.color)), 'all events carry a channel color');
  ok(all.every((h) => typeof h.value.orbit === 'number'), 'all events carry an orbit');
  if (demo.id === 'house') {
    const kick = p.channels[0];
    const kicks = all.filter((h) => h.value.color === kick.color);
    ok(kicks.length === 24 * 4 + 4, `house: 24 bars x 4 kicks + 4 fill kicks = ${kicks.length}`);
    const firstKick = Math.min(...kicks.map((h) => h.whole.begin.valueOf()));
    ok(firstKick === 4, `house: first kick at bar 4 (${firstKick})`);
    const chords = p.channels.find((c) => c.name === 'Chords');
    const ch = all.filter((h) => h.value.color === chords.color);
    const c0 = ch.find((h) => h.whole.begin.valueOf() === 0);
    const c4 = ch.find((h) => h.whole.begin.valueOf() === 4);
    ok(c0 && c4 && c4.value.cutoff > c0.value.cutoff, `automation raises chord cutoff (${c0?.value.cutoff?.toFixed(0)} -> ${c4?.value.cutoff?.toFixed(0)})`);
    const bass = all.filter((h) => h.value.color === p.channels.find((c) => c.name === 'Bass').color);
    ok(bass.length > 0 && bass.every((h) => typeof h.value.note === 'string'), `bass has ${bass.length} note events`);
    const duck = kicks[0].value.duckorbit;
    ok(Array.isArray(duck) && duck.join() === '3,4', `kick ducks orbits ${JSON.stringify(duck)}`);
    const lead = all.filter((h) => h.value.s === 'triosc');
    ok(lead.length === 17 * 3, `lead plugin notes: ${lead.length}`);
    const spark = all.filter((h) => h.value.s === 'fmkeys');
    ok(spark.length > 0 && spark.every(h => h.value.fmkeys_index === 3), `code channel with plugin control: ${spark.length}`);
    // loop wrap check: bar 32 == bar 0
    const at0 = onsets(spat, 0, 1).length, at32 = onsets(spat, 32, 33).length;
    ok(at0 === at32, `song loops (bar0 ${at0} events, bar32 ${at32})`);
  }
  // live mode
  const live = M.compileProject(p, { mode: 'live', getPlugin });
  await evalCode(live.code, 'live');
  // export mode with plugin sources, evaluated in a fresh scope
  const exp = M.compileProject(p, { mode: 'song', forExport: true, getPlugin, allPluginIds });
  ok(exp.code.includes('definePlugin'), 'export embeds plugin sources');
  registered.clear();
  delete globalThis.definePlugin;
  await evalCode(exp.code, 'export code');
  ok(p.channels.filter(c => c.kind === 'plugin').every((c) => registered.has(c.sound)), `export registers plugins: ${[...registered.keys()].join(', ')}`);
}

// VST3 channels (native app): notes go to the "native" sound with the channel id
{
  console.log('\n== VST3 channel');
  core.registerControl('vst');
  const p = M.DEMOS[0].make();
  const ch = M.createChannel(p, { kind: 'vst', name: 'Keys', vst: { pluginId: 'VST3-Test-abc-def', name: 'Test Synth', fx: [] } });
  p.channels.push(ch);
  const pt = p.patterns[0];
  pt.notes[ch.id] = [
    { id: 'n1', key: 60, start: 0, len: 96, vel: 1 },
    { id: 'n2', key: 67, start: 192, len: 48, vel: 0.5 },
  ];
  const res = M.compileProject(p, { mode: 'pattern', patternId: pt.id, getPlugin: M.getPluginInfo });
  ok(res.code.includes(`.s("native").vst('${ch.id}')`), 'vst channel compiles to .s("native").vst(id)');
  const pat = await evalCode(res.code, 'pattern with VST3 channel');
  const hs = onsets(pat, 0, pt.bars).filter((h) => h.value.s === 'native');
  ok(hs.length === 2 * pt.bars, `VST3 notes reach the native sound (${hs.length})`);
  ok(hs.every((h) => h.value.vst === ch.id), 'VST3 events carry the channel id');
  ok(hs.some((h) => h.value.note === 'c4' || h.value.note === 60) && hs.some((h) => h.value.velocity === 0.5), 'VST3 note + velocity');
  const exp = M.compileProject(p, { mode: 'pattern', patternId: pt.id, forExport: true, getPlugin: M.getPluginInfo });
  ok(!exp.code.includes('"native"') && exp.code.includes('VST3: Test Synth'), 'export uses a stand-in synth for VST3 channels');
  await evalCode(exp.code, 'export with VST3 stand-in');
}

// notes -> mini
const v = M.notesToVoices([
  { id: 'a', key: 60, start: 0, len: 96, vel: 1 },
  { id: 'b', key: 64, start: 0, len: 96, vel: 1 },
  { id: 'c', key: 67, start: 48, len: 144, vel: 0.5 },
], 384, 384, 0);
console.log('\nvoices', JSON.stringify(v));
ok(v.length === 2, 'overlapping notes split into 2 voices');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
