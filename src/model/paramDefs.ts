import type { ChannelKind } from './types';

export type Curve = 'lin' | 'log' | 'exp';

export interface ParamDef {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  /** value shown when the param is not set (not emitted to code) */
  def: number;
  step?: number;
  curve?: Curve;
  unit?: string;
  /** Strudel control used in generated code */
  control: string;
  kinds?: ChannelKind[];
  automatable?: boolean;
  options?: { label: string; value: number }[];
  hint?: string;
}

const ALL: ChannelKind[] = ['sample', 'synth', 'soundfont', 'plugin', 'code'];
const TONAL: ChannelKind[] = ['synth', 'soundfont', 'plugin', 'sample'];

export const CHANNEL_PARAMS: ParamDef[] = [
  // Envelope
  { key: 'attack', label: 'Attack', group: 'Envelope', min: 0, max: 4, def: 0.001, curve: 'exp', unit: 's', control: 'attack', kinds: ALL, hint: 'Amp envelope attack time' },
  { key: 'decay', label: 'Decay', group: 'Envelope', min: 0, max: 4, def: 0.05, curve: 'exp', unit: 's', control: 'decay', kinds: ALL },
  { key: 'sustain', label: 'Sustain', group: 'Envelope', min: 0, max: 1, def: 1, unit: '', control: 'sustain', kinds: ALL },
  { key: 'release', label: 'Release', group: 'Envelope', min: 0, max: 8, def: 0.01, curve: 'exp', unit: 's', control: 'release', kinds: ALL },
  { key: 'clip', label: 'Gate', group: 'Envelope', min: 0.05, max: 4, def: 1, curve: 'exp', unit: 'x', control: 'clip', kinds: ALL, hint: 'Multiplies note length (legato/staccato)' },

  // Filter
  { key: 'cutoff', label: 'Cutoff', group: 'Filter', min: 20, max: 20000, def: 20000, curve: 'log', unit: 'Hz', control: 'lpf', kinds: ALL, automatable: true, hint: 'Low-pass filter cutoff' },
  { key: 'resonance', label: 'Reso', group: 'Filter', min: 0, max: 30, def: 0, curve: 'exp', unit: '', control: 'lpq', kinds: ALL, automatable: true },
  { key: 'lpenv', label: 'Env Amt', group: 'Filter', min: -8, max: 8, def: 0, unit: 'oct', control: 'lpenv', kinds: ALL, automatable: true, hint: 'Filter envelope amount in octaves' },
  { key: 'lpattack', label: 'F.Att', group: 'Filter', min: 0, max: 2, def: 0.01, curve: 'exp', unit: 's', control: 'lpattack', kinds: ALL },
  { key: 'lpdecay', label: 'F.Dec', group: 'Filter', min: 0, max: 2, def: 0.1, curve: 'exp', unit: 's', control: 'lpdecay', kinds: ALL },
  { key: 'lpsustain', label: 'F.Sus', group: 'Filter', min: 0, max: 1, def: 1, control: 'lpsustain', kinds: ALL },
  {
    key: 'ftype', label: 'Type', group: 'Filter', min: 0, max: 2, def: 0, step: 1, control: 'ftype', kinds: ALL,
    options: [ { label: '12dB', value: 0 }, { label: 'Ladder', value: 1 }, { label: '24dB', value: 2 } ],
  },
  { key: 'hcutoff', label: 'HP Cut', group: 'Filter', min: 20, max: 20000, def: 20, curve: 'log', unit: 'Hz', control: 'hpf', kinds: ALL, automatable: true, hint: 'High-pass filter cutoff' },
  { key: 'hresonance', label: 'HP Reso', group: 'Filter', min: 0, max: 30, def: 0, curve: 'exp', control: 'hpq', kinds: ALL },

  // Pitch
  { key: 'transpose', label: 'Pitch', group: 'Pitch', min: -24, max: 24, def: 0, step: 1, unit: 'st', control: '__transpose', kinds: [...ALL, 'vst'], hint: 'Transpose in semitones' },
  { key: 'speed', label: 'Speed', group: 'Pitch', min: -2, max: 4, def: 1, unit: 'x', control: 'speed', kinds: ['sample'], automatable: true, hint: 'Sample playback speed (negative = reverse)' },
  { key: 'vib', label: 'Vibrato', group: 'Pitch', min: 0, max: 16, def: 0, unit: 'Hz', control: 'vib', kinds: TONAL },
  { key: 'vibmod', label: 'Vib Depth', group: 'Pitch', min: 0, max: 2, def: 0.5, unit: 'st', control: 'vibmod', kinds: TONAL },
  { key: 'penv', label: 'P.Env', group: 'Pitch', min: -24, max: 24, def: 0, unit: 'st', control: 'penv', kinds: ALL, hint: 'Pitch envelope depth (semitones)' },
  { key: 'pdecay', label: 'P.Dec', group: 'Pitch', min: 0, max: 2, def: 0.1, curve: 'exp', unit: 's', control: 'pdecay', kinds: ALL },

  // Sample
  { key: 'begin', label: 'Start', group: 'Sample', min: 0, max: 1, def: 0, control: 'begin', kinds: ['sample'] },
  { key: 'end', label: 'End', group: 'Sample', min: 0, max: 1, def: 1, control: 'end', kinds: ['sample'] },
  { key: 'cut', label: 'Cut grp', group: 'Sample', min: 0, max: 8, def: 0, step: 1, control: 'cut', kinds: ['sample'], hint: 'Choke group: a new note cuts previous notes of the same group' },
  { key: 'loop', label: 'Loop', group: 'Sample', min: 0, max: 1, def: 0, step: 1, control: 'loop', kinds: ['sample'], options: [ { label: 'Off', value: 0 }, { label: 'On', value: 1 } ] },

  // Synth
  { key: 'unison', label: 'Unison', group: 'Synth', min: 1, max: 8, def: 5, step: 1, control: 'unison', kinds: ['synth'], hint: 'supersaw voices' },
  { key: 'spread', label: 'Spread', group: 'Synth', min: 0, max: 1, def: 0.6, control: 'spread', kinds: ['synth'] },
  { key: 'detune', label: 'Detune', group: 'Synth', min: 0, max: 1, def: 0.18, control: 'detune', kinds: ['synth'] },
  { key: 'fm', label: 'FM Amt', group: 'Synth', min: 0, max: 16, def: 0, control: 'fm', kinds: ['synth'], automatable: true, hint: 'Frequency modulation index' },
  { key: 'fmh', label: 'FM Ratio', group: 'Synth', min: 0.25, max: 8, def: 1, control: 'fmh', kinds: ['synth'] },
  { key: 'noise', label: 'Noise', group: 'Synth', min: 0, max: 1, def: 0, control: 'noise', kinds: ['synth'] },

  // FX (per voice)
  { key: 'distort', label: 'Distort', group: 'FX', min: 0, max: 8, def: 0, curve: 'exp', control: 'distort', kinds: ALL, automatable: true },
  { key: 'shape', label: 'Shape', group: 'FX', min: 0, max: 0.95, def: 0, control: 'shape', kinds: ALL },
  { key: 'crush', label: 'Crush', group: 'FX', min: 1, max: 16, def: 16, step: 1, unit: 'bit', control: 'crush', kinds: ALL, automatable: true },
  { key: 'coarse', label: 'Downsmp', group: 'FX', min: 1, max: 32, def: 1, step: 1, unit: 'x', control: 'coarse', kinds: ALL, automatable: true },
  { key: 'phaser', label: 'Phaser', group: 'FX', min: 0, max: 10, def: 0, unit: 'Hz', control: 'phaserrate', kinds: ALL },
  { key: 'phaserdepth', label: 'Ph.Depth', group: 'FX', min: 0, max: 1, def: 0.75, control: 'phaserdepth', kinds: ALL },
  { key: 'tremolo', label: 'Tremolo', group: 'FX', min: 0, max: 16, def: 0, unit: '/bar', control: 'tremolosync', kinds: ALL, hint: 'Tremolo rate in cycles per bar' },
  { key: 'tremolodepth', label: 'Tr.Depth', group: 'FX', min: 0, max: 1, def: 1, control: 'tremolodepth', kinds: ALL },
  {
    key: 'vowel', label: 'Vowel', group: 'FX', min: 0, max: 5, def: 0, step: 1, control: 'vowel', kinds: ALL,
    options: [
      { label: 'Off', value: 0 }, { label: 'a', value: 1 }, { label: 'e', value: 2 },
      { label: 'i', value: 3 }, { label: 'o', value: 4 }, { label: 'u', value: 5 },
    ],
  },
];

export const CHANNEL_PARAM_MAP: Record<string, ParamDef> = Object.fromEntries(CHANNEL_PARAMS.map((p) => [p.key, p]));

/** extra automatable pseudo params stored on the channel itself */
export const CHANNEL_CORE_AUTOMATION: ParamDef[] = [
  { key: 'volume', label: 'Volume', group: 'Channel', min: 0, max: 1.5, def: 0.8, control: 'gain', automatable: true },
  { key: 'pan', label: 'Pan', group: 'Channel', min: 0, max: 1, def: 0.5, control: 'pan', automatable: true },
];

export const PARAM_GROUPS = ['Envelope', 'Filter', 'Pitch', 'Sample', 'Synth', 'FX'];

// ---------- value <-> normalized (0..1) mapping used by knobs & automation ----------
export function toNorm(def: Pick<ParamDef, 'min' | 'max' | 'curve'>, v: number): number {
  const { min, max, curve } = def;
  if (curve === 'log' && min > 0) {
    return clamp01(Math.log(v / min) / Math.log(max / min));
  }
  if (curve === 'exp') {
    const t = clamp01((v - min) / (max - min));
    return Math.sqrt(t);
  }
  return clamp01((v - min) / (max - min));
}

export function fromNorm(def: Pick<ParamDef, 'min' | 'max' | 'curve' | 'step'>, n: number): number {
  const { min, max, curve, step } = def;
  n = clamp01(n);
  let v: number;
  if (curve === 'log' && min > 0) v = min * Math.pow(max / min, n);
  else if (curve === 'exp') v = min + (max - min) * n * n;
  else v = min + (max - min) * n;
  if (step) v = Math.round(v / step) * step;
  return v;
}

export function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function formatParam(def: ParamDef, v: number): string {
  if (def.options) {
    const o = def.options.find((o) => o.value === Math.round(v));
    return o ? o.label : String(v);
  }
  let s: string;
  const a = Math.abs(v);
  if (def.unit === 'Hz' && a >= 1000) s = (v / 1000).toFixed(a >= 10000 ? 1 : 2) + 'k';
  else if (def.step && def.step >= 1) s = String(Math.round(v));
  else if (a >= 100) s = v.toFixed(0);
  else if (a >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  return s + (def.unit ? ' ' + def.unit : '');
}

export const VOWELS = ['', 'a', 'e', 'i', 'o', 'u'];
