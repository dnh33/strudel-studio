// Core data model of a Strudel Studio project.
// Time units: 1 bar = 1 Strudel cycle. Notes use ticks (PPQ = 96 per beat).

export type ID = string;

export const PPQ = 96; // ticks per quarter note (beat)
export const TICKS_PER_STEP = 24; // 1/16 note

export type ChannelKind = 'sample' | 'synth' | 'soundfont' | 'plugin' | 'code' | 'vst';

/** a VST3 plug-in slot (native app only) */
export interface VstSlot {
  id: ID;
  pluginId: string; // JUCE plug-in identifier string
  name: string;
  bypass: boolean;
}

/** native VST3 instrument channel: notes are played by the Strudel Studio native app */
export interface VstChannel {
  pluginId: string;
  name: string;
  vendor?: string;
  fx: VstSlot[];
}

export interface Channel {
  id: ID;
  name: string;
  color: string;
  kind: ChannelKind;
  /** sample name (bd), synth waveform (sawtooth), soundfont (gm_piano) or plugin id */
  sound: string;
  /** drum machine bank, e.g. RolandTR909 (samples only) */
  bank: string;
  /** sample / soundfont variation index */
  n: number;
  /** strudel expression for code channels */
  code: string;
  /** midi note that steps play (and the sample's original pitch reference) */
  rootNote: number;
  volume: number; // 0..1.5 (maps to gain)
  pan: number; // 0..1
  mute: boolean;
  solo: boolean;
  /** mixer insert index: 0 = master, 1..n inserts */
  insert: number;
  /** per voice sound shaping params (see paramDefs.ts) */
  params: Record<string, number>;
  /** plugin instrument params, keyed by the plugin param key */
  pluginParams: Record<string, number>;
  /** kind === 'vst': the hosted VST3 instrument + effect chain */
  vst?: VstChannel;
}

export interface Note {
  id: ID;
  key: number; // midi note number
  start: number; // ticks from pattern start
  len: number; // ticks
  vel: number; // 0..1
}

export interface Pattern {
  id: ID;
  name: string;
  color: string;
  /** length in bars (cycles) */
  bars: number;
  /** channelId -> step velocities (0 = off). length = bars * stepsPerBar */
  steps: Record<ID, number[]>;
  /** channelId -> piano roll notes (if non-empty they replace the steps) */
  notes: Record<ID, Note[]>;
  /** code channels: channelId -> enabled in this pattern */
  code: Record<ID, boolean>;
}

export interface PlaylistTrack {
  id: ID;
  name: string;
  color: string;
  mute: boolean;
}

export interface AutomationPoint {
  x: number; // 0..1 across clip length
  y: number; // 0..1 normalized value
}

export interface AutomationTarget {
  channelId: ID;
  param: string; // a key of AUTOMATABLE params
}

export interface Clip {
  id: ID;
  track: number; // playlist track index
  start: number; // in bars (can be fractional)
  length: number; // in bars
  kind: 'pattern' | 'automation';
  patternId?: ID;
  automation?: {
    name: string;
    target: AutomationTarget | null;
    points: AutomationPoint[];
  };
}

export interface FxSlot {
  id: ID;
  pluginId: string; // native insert effect id
  enabled: boolean;
  mix: number; // 0..1 wet/dry
  params: Record<string, number>;
}

export interface MixerInsert {
  id: ID;
  name: string;
  color: string;
  volume: number; // 0..1.25 linear
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  /** native (WebAudio) effect slots */
  fx: FxSlot[];
  /** Strudel orbit-level effects (rendered into the pattern code) */
  reverb: number; // room send 0..1
  reverbSize: number; // roomsize 0..10
  reverbLp: number; // roomlp Hz
  delay: number; // delay send 0..1
  delaySteps: number; // delay time in 1/16 steps
  delayFeedback: number; // 0..0.95
  djf: number; // DJ filter 0..1 (0.5 = off)
  /** sidechain: when channels on this insert play, duck these inserts */
  duckTargets: number[];
  duckDepth: number; // 0..1
  duckRelease: number; // seconds
}

export interface Project {
  format: 'strudel-studio';
  version: 1;
  name: string;
  author: string;
  bpm: number;
  beatsPerBar: number;
  swing: number; // 0..1
  masterVolume: number;
  channels: Channel[];
  patterns: Pattern[];
  tracks: PlaylistTrack[];
  clips: Clip[];
  mixer: MixerInsert[]; // index 0 = master
  /** free live-code editor contents */
  liveCode: string;
  /** user-written plugin instruments (Plugin Lab) */
  userPlugins: UserPlugin[];
  /** VST3 plug-in states (native app), key = "channelId|slotId" */
  nativeStates?: Record<string, { plugin: string; state: string }>;
  createdAt: number;
  updatedAt: number;
}

export interface UserPlugin {
  id: string; // sound name, must be unique, lowercase
  name: string;
  source: string; // JS source of the plugin (see plugins/sdk.ts)
}

export type PlayMode = 'pattern' | 'song' | 'live';

export const stepsPerBar = (p: Pick<Project, 'beatsPerBar'>) => p.beatsPerBar * 4;
export const ticksPerBar = (p: Pick<Project, 'beatsPerBar'>) => p.beatsPerBar * PPQ;
