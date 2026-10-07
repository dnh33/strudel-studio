import type { Channel, ChannelKind, Clip, FxSlot, MixerInsert, Pattern, PlaylistTrack, Project } from './types';
import { stepsPerBar } from './types';
import { paletteColor, uid, uniqueColor } from './util';

export function createChannel(project: Project | null, init: Partial<Channel> & { kind: ChannelKind }): Channel {
  const used = new Set((project?.channels ?? []).map((c) => c.color.toLowerCase()));
  const idx = project?.channels.length ?? 0;
  const base = init.color ?? paletteColor(idx);
  const kind = init.kind;
  const defaultRoot = kind === 'sample' ? 36 : 60;
  return {
    id: uid('ch'),
    name: init.name ?? (init.sound || 'Channel'),
    color: uniqueColor(base, used),
    kind,
    sound: init.sound ?? (kind === 'synth' ? 'sawtooth' : kind === 'soundfont' ? 'gm_piano' : kind === 'sample' ? 'bd' : ''),
    bank: init.bank ?? '',
    n: init.n ?? 0,
    code: init.code ?? (kind === 'code' ? 'n("0 2 4 <7 9>").scale("C4:minor").s("triangle")' : ''),
    rootNote: init.rootNote ?? defaultRoot,
    volume: init.volume ?? 0.8,
    pan: init.pan ?? 0.5,
    mute: false,
    solo: false,
    insert: init.insert ?? 0,
    params: init.params ?? {},
    pluginParams: init.pluginParams ?? {},
    ...(init.vst ? { vst: init.vst } : {}),
  };
}

export function createPattern(project: Project | null, name?: string, bars = 1): Pattern {
  const idx = project?.patterns.length ?? 0;
  return {
    id: uid('pt'),
    name: name ?? `Pattern ${idx + 1}`,
    color: paletteColor(idx + 3),
    bars,
    steps: {},
    notes: {},
    code: {},
  };
}

export function createInsert(index: number, name?: string): MixerInsert {
  return {
    id: uid('mx'),
    name: name ?? (index === 0 ? 'Master' : `Insert ${index}`),
    color: index === 0 ? '#c8ccd2' : paletteColor(index - 1),
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    fx: [],
    reverb: 0,
    reverbSize: 2,
    reverbLp: 8000,
    delay: 0,
    delaySteps: 3,
    delayFeedback: 0.4,
    djf: 0.5,
    duckTargets: [],
    duckDepth: 0.8,
    duckRelease: 0.15,
  };
}

export function createFxSlot(pluginId: string, params: Record<string, number> = {}): FxSlot {
  return { id: uid('fx'), pluginId, enabled: true, mix: 1, params };
}

export function createTrack(i: number): PlaylistTrack {
  return { id: uid('tr'), name: `Track ${i + 1}`, color: '#5d6773', mute: false };
}

export function createClip(init: Omit<Clip, 'id'>): Clip {
  return { id: uid('cl'), ...init };
}

export const NUM_INSERTS = 16;
export const NUM_TRACKS = 16;

export function createEmptyProject(name = 'Untitled'): Project {
  const now = Date.now();
  const p: Project = {
    format: 'strudel-studio',
    version: 1,
    name,
    author: '',
    bpm: 128,
    beatsPerBar: 4,
    swing: 0,
    masterVolume: 0.9,
    channels: [],
    patterns: [],
    tracks: Array.from({ length: NUM_TRACKS }, (_, i) => createTrack(i)),
    clips: [],
    mixer: Array.from({ length: NUM_INSERTS + 1 }, (_, i) => createInsert(i)),
    liveCode: DEFAULT_LIVE_CODE,
    userPlugins: [],
    createdAt: now,
    updatedAt: now,
  };
  // master gets a gentle limiter by default
  p.mixer[0].fx.push(createFxSlot('limiter', {}));
  p.mixer[0].volume = 0.9;
  p.patterns.push(createPattern(p, 'Pattern 1', 1));
  return p;
}

export const DEFAULT_LIVE_CODE = `// Live code: a free Strudel REPL (like strudel.cc).
// Press Ctrl+Enter to play this code. Everything defined by your
// project (patterns + channel instruments) is available here, e.g.
//   $: kick(beat.kick)
// Try:
$: s("bd*2, ~ cp, hh*8").bank("RolandTR909")
$: note("<c3 eb3 g2 bb2>").s("sawtooth").lpf(800).lpenv(3).release(.2)
`;

/** make sure pattern step arrays exist and have the right length for the pattern */
export function stepCount(project: Project, pattern: Pattern) {
  return pattern.bars * stepsPerBar(project);
}

export function getSteps(project: Project, pattern: Pattern, channelId: string): number[] {
  const n = stepCount(project, pattern);
  const s = pattern.steps[channelId] ?? [];
  if (s.length === n) return s;
  const out = new Array(n).fill(0);
  for (let i = 0; i < Math.min(n, s.length); i++) out[i] = s[i];
  return out;
}

/** default insert assignment: next insert not used by another channel */
export function nextFreeInsert(project: Project): number {
  const used = new Set(project.channels.map((c) => c.insert));
  for (let i = 1; i < project.mixer.length; i++) if (!used.has(i)) return i;
  return 0;
}
