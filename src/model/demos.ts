import type { Channel, Note, Pattern, Project } from './types';
import { TICKS_PER_STEP } from './types';
import { createChannel, createClip, createEmptyProject, createFxSlot, createPattern } from './factory';
import { uid } from './util';

/** "x...o..." -> velocities (x = 1, o = .6, - = .35, . = off) */
export function stepsFrom(str: string): number[] {
  return [...str.replace(/\s+/g, '')].map((c) => (c === 'x' ? 1 : c === 'o' ? 0.6 : c === '-' ? 0.35 : 0));
}

const N = (key: number, step: number, len: number, vel = 0.9): Note => ({
  id: uid('n'),
  key,
  start: step * TICKS_PER_STEP,
  len: len * TICKS_PER_STEP,
  vel,
});

function addChannel(p: Project, init: Partial<Channel> & { kind: Channel['kind'] }) {
  const ch = createChannel(p, init);
  p.channels.push(ch);
  return ch;
}

function addPattern(p: Project, name: string, bars: number, color?: string): Pattern {
  const pt = createPattern(p, name, bars);
  if (color) pt.color = color;
  p.patterns.push(pt);
  return pt;
}

const chord = (keys: number[], step: number, len: number, vel = 0.8) => keys.map((k) => N(k, step, len, vel));

export function createHouseDemo(): Project {
  const p = createEmptyProject('Sunset House (demo)');
  p.patterns = [];
  p.bpm = 124;
  p.author = 'Strudel Studio';
  const ins = (i: number, name: string, color: string) => {
    p.mixer[i].name = name;
    p.mixer[i].color = color;
    return p.mixer[i];
  };

  const kickIns = ins(1, 'Kick', '#ff8a3d');
  kickIns.duckTargets = [3, 4];
  kickIns.duckDepth = 0.75;
  kickIns.duckRelease = 0.18;
  kickIns.fx.push(createFxSlot('eq3', { low: 3, mid: -1, high: 0 }));
  const drums = ins(2, 'Drums', '#ffc53d');
  drums.reverb = 0.12;
  drums.reverbSize = 1.5;
  drums.fx.push(createFxSlot('compressor', { threshold: -18, ratio: 4 }));
  const bassIns = ins(3, 'Bass', '#3ddc97');
  bassIns.fx.push(createFxSlot('drive', { drive: 0.25, tone: 0.5 }));
  const chordsIns = ins(4, 'Chords', '#5b8cff');
  chordsIns.reverb = 0.35;
  chordsIns.reverbSize = 4;
  chordsIns.fx.push(createFxSlot('chorus', { rate: 0.6, depth: 0.5 }));
  const leadIns = ins(5, 'Lead', '#a77bff');
  leadIns.delay = 0.3;
  leadIns.delaySteps = 3;
  leadIns.delayFeedback = 0.45;
  leadIns.reverb = 0.2;
  leadIns.reverbSize = 3;
  const sparkIns = ins(6, 'Sparkle', '#ff6bcb');
  sparkIns.reverb = 0.4;
  sparkIns.reverbSize = 5;
  sparkIns.fx.push(createFxSlot('width', { width: 1.6 }));

  const kick = addChannel(p, { kind: 'sample', name: 'Kick', sound: 'bd', bank: 'RolandTR909', insert: 1, volume: 1, color: '#ff8a3d' });
  const clap = addChannel(p, { kind: 'sample', name: 'Clap', sound: 'cp', bank: 'RolandTR909', insert: 2, volume: 0.7, color: '#ffc53d' });
  const hat = addChannel(p, { kind: 'sample', name: 'Hat', sound: 'hh', bank: 'RolandTR909', insert: 2, volume: 0.55, pan: 0.58, color: '#d4a373' });
  const ohat = addChannel(p, { kind: 'sample', name: 'Open Hat', sound: 'oh', bank: 'RolandTR909', insert: 2, volume: 0.45, pan: 0.42, color: '#b5e48c' });
  const bass = addChannel(p, {
    kind: 'synth', name: 'Bass', sound: 'sawtooth', insert: 3, volume: 0.75, rootNote: 45, color: '#3ddc97',
    params: { cutoff: 520, resonance: 6, lpenv: 2.5, lpdecay: 0.12, lpsustain: 0.2, attack: 0.003, decay: 0.2, sustain: 0.6, release: 0.08 },
  });
  const chords = addChannel(p, {
    kind: 'plugin', name: 'Chords', sound: 'superpad', insert: 4, volume: 0.6, color: '#5b8cff',
    params: { cutoff: 3200 }, pluginParams: { bright: 0.5, voices: 5, detune: 16 },
  });
  const lead = addChannel(p, {
    kind: 'plugin', name: 'Lead', sound: 'triosc', insert: 5, volume: 0.5, color: '#a77bff',
    params: { cutoff: 4200, resonance: 3, release: 0.25 },
  });
  const spark = addChannel(p, {
    kind: 'code', name: 'Sparkle', insert: 6, volume: 0.45, color: '#ff6bcb',
    code: 'n("0 [2 4] <7 9> 4 [2 0] 7 <4 11> 2").scale("A4:minor").s("fmkeys").fmkeys_index(3).clip(.5).jux(rev)',
  });

  // ---- patterns
  const beat = addPattern(p, 'Beat', 1, '#ff8a3d');
  beat.steps[kick.id] = stepsFrom('x...x...x...x...');
  beat.steps[clap.id] = stepsFrom('....x.......x...');
  beat.steps[hat.id] = stepsFrom('-.x--.x--.x--.xo');
  beat.steps[ohat.id] = stepsFrom('..x...x...x...x.');

  const beat2 = addPattern(p, 'Beat + Fill', 1, '#ffc53d');
  beat2.steps[kick.id] = stepsFrom('x...x...x...x.x.');
  beat2.steps[clap.id] = stepsFrom('....x.......x-ox');
  beat2.steps[hat.id] = stepsFrom('-.x--.x--.x-xxxx');
  beat2.steps[ohat.id] = stepsFrom('..x...x...x.....');

  const bassline = addPattern(p, 'Bassline', 4, '#3ddc97');
  const roots = [45, 41, 48, 43]; // A2 F2 C3 G2
  const bn: Note[] = [];
  roots.forEach((r, bar) => {
    const o = bar * 16;
    bn.push(N(r, o + 2, 2, 0.95), N(r, o + 6, 2, 0.85), N(r + 12, o + 8, 1, 0.7), N(r, o + 10, 2, 0.9), N(r, o + 14, 2, 0.85));
  });
  bassline.notes[bass.id] = bn;

  const prog = addPattern(p, 'Chords', 4, '#5b8cff');
  prog.notes[chords.id] = [
    ...chord([57, 60, 64, 69], 0, 16),
    ...chord([53, 57, 60, 65], 16, 16),
    ...chord([55, 60, 64, 67], 32, 16),
    ...chord([55, 59, 62, 67], 48, 16),
  ];

  const melody = addPattern(p, 'Lead', 4, '#a77bff');
  melody.notes[lead.id] = [
    N(76, 0, 3), N(74, 3, 3), N(72, 6, 2), N(69, 8, 6),
    N(72, 16, 3), N(74, 19, 3), N(76, 22, 2), N(77, 24, 4), N(76, 28, 4),
    N(79, 32, 3), N(76, 35, 3), N(74, 38, 2), N(72, 40, 8),
    N(71, 48, 3), N(72, 51, 3), N(74, 54, 2), N(76, 56, 8),
  ];

  const sparkle = addPattern(p, 'Sparkle', 4, '#ff6bcb');
  sparkle.code[spark.id] = true;

  // ---- playlist
  const names = ['Drums', 'Bass', 'Chords', 'Lead', 'Sparkle', 'Automation'];
  names.forEach((n, i) => (p.tracks[i].name = n));
  const clip = (track: number, pt: Pattern, start: number, length = pt.bars) =>
    p.clips.push(createClip({ kind: 'pattern', track, patternId: pt.id, start, length }));

  for (let b = 4; b < 32; b++) {
    if (b >= 16 && b < 20) continue; // breakdown
    clip(0, b % 8 === 7 || b === 31 ? beat2 : beat, b, 1);
  }
  clip(1, bassline, 8, 8);
  clip(1, bassline, 20, 12);
  clip(2, prog, 0, 32);
  clip(3, melody, 12, 4);
  clip(3, melody, 24, 8);
  clip(4, sparkle, 16, 4);
  clip(4, sparkle, 28, 4);
  p.clips.push(
    createClip({
      kind: 'automation', track: 5, start: 0, length: 8,
      automation: { name: 'Chords cutoff', target: { channelId: chords.id, param: 'cutoff' }, points: [ { x: 0, y: 0.35 }, { x: 1, y: 0.82 } ] },
    }),
  );
  p.clips.push(
    createClip({
      kind: 'automation', track: 5, start: 16, length: 4,
      automation: { name: 'Bass filter build', target: { channelId: bass.id, param: 'cutoff' }, points: [ { x: 0, y: 0.45 }, { x: 0.9, y: 0.8 }, { x: 1, y: 0.62 } ] },
    }),
  );
  return p;
}

export function createLofiDemo(): Project {
  const p = createEmptyProject('Rainy Lo-fi (demo)');
  p.patterns = [];
  p.bpm = 82;
  p.swing = 0.45;
  p.author = 'Strudel Studio';
  p.mixer[1].name = 'Drums';
  p.mixer[1].fx.push(createFxSlot('lofi', { bits: 10, tone: 0.55 }));
  p.mixer[1].fx.push(createFxSlot('compressor', { threshold: -20, ratio: 3 }));
  p.mixer[2].name = 'Keys';
  p.mixer[2].reverb = 0.3;
  p.mixer[2].reverbSize = 3;
  p.mixer[2].fx.push(createFxSlot('chorus', { rate: 0.3, depth: 0.7 }));
  p.mixer[3].name = 'Bass';
  p.mixer[4].name = 'Pluck';
  p.mixer[4].delay = 0.35;
  p.mixer[4].delaySteps = 6;
  p.mixer[4].reverb = 0.3;

  const kick = addChannel(p, { kind: 'sample', name: 'Kick', sound: 'bd', bank: 'KorgMinipops', insert: 1, volume: 0.9 });
  const snare = addChannel(p, { kind: 'sample', name: 'Snare', sound: 'sd', bank: 'KorgMinipops', insert: 1, volume: 0.6 });
  const hat = addChannel(p, { kind: 'sample', name: 'Hat', sound: 'hh', bank: 'KorgMinipops', insert: 1, volume: 0.4 });
  const keys = addChannel(p, { kind: 'soundfont', name: 'E-Piano', sound: 'gm_epiano1', insert: 2, volume: 0.7, params: { release: 0.6 } });
  const bass = addChannel(p, { kind: 'plugin', name: '808', sound: 'sub808', insert: 3, volume: 0.8, rootNote: 36, pluginParams: { glide: 5, drive: 0.25 } });
  const pl = addChannel(p, { kind: 'plugin', name: 'Pluck', sound: 'pluck', insert: 4, volume: 0.55, pluginParams: { decay: 3, bright: 0.7 } });

  const drums = addPattern(p, 'Drums', 1);
  drums.steps[kick.id] = stepsFrom('x.....x...x.....');
  drums.steps[snare.id] = stepsFrom('....x.......x..-');
  drums.steps[hat.id] = stepsFrom('x.o.x.o.x.o.x.oo');

  const ch = addPattern(p, 'Keys', 2);
  ch.notes[keys.id] = [
    ...chord([62, 65, 69, 72], 0, 14, 0.7), // Dm9-ish
    ...chord([67, 71, 74, 77], 16, 14, 0.7), // G7
  ];
  const bl = addPattern(p, '808', 2);
  bl.notes[bass.id] = [N(38, 0, 6), N(38, 10, 4, 0.7), N(43, 16, 6), N(41, 24, 4, 0.7), N(43, 28, 3, 0.8)];
  const ar = addPattern(p, 'Pluck', 2);
  ar.notes[pl.id] = [N(74, 0, 2), N(77, 3, 2), N(81, 6, 3), N(79, 10, 2), N(77, 16, 2), N(74, 19, 2), N(71, 22, 4), N(72, 28, 3)];

  ['Drums', 'Keys', '808', 'Pluck'].forEach((n, i) => (p.tracks[i].name = n));
  const clip = (track: number, pt: Pattern, start: number, length: number) =>
    p.clips.push(createClip({ kind: 'pattern', track, patternId: pt.id, start, length }));
  clip(1, ch, 0, 16);
  clip(0, drums, 2, 14);
  clip(2, bl, 4, 12);
  clip(3, ar, 8, 8);
  return p;
}

export const DEMOS = [
  { id: 'house', name: 'Sunset House', make: createHouseDemo },
  { id: 'lofi', name: 'Rainy Lo-fi', make: createLofiDemo },
];
