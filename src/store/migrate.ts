import type { Project } from '../model/types';
import { createEmptyProject, createInsert, createTrack, NUM_INSERTS, NUM_TRACKS } from '../model/factory';

/** validates and fills in missing fields of a loaded project */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateProject(raw: any): Project {
  if (!raw || typeof raw !== 'object') throw new Error('Not a project file');
  if (raw.format !== 'strudel-studio') throw new Error('Not a Strudel Studio project (missing "format": "strudel-studio")');
  const base = createEmptyProject(raw.name ?? 'Untitled');
  const p: Project = { ...base, ...raw };
  p.channels = (raw.channels ?? []).map((c: any) => ({
    params: {},
    pluginParams: {},
    code: '',
    bank: '',
    n: 0,
    mute: false,
    solo: false,
    insert: 0,
    volume: 0.8,
    pan: 0.5,
    rootNote: c?.kind === 'sample' ? 36 : 60,
    ...c,
  }));
  p.patterns = (raw.patterns ?? []).map((pt: any) => ({ steps: {}, notes: {}, code: {}, bars: 1, ...pt }));
  if (!p.patterns.length) p.patterns = base.patterns;
  p.tracks = raw.tracks?.length ? raw.tracks : base.tracks;
  while (p.tracks.length < NUM_TRACKS) p.tracks.push(createTrack(p.tracks.length));
  p.mixer = (raw.mixer?.length ? raw.mixer : base.mixer).map((m: any, i: number) => ({ ...createInsert(i), ...m }));
  while (p.mixer.length < NUM_INSERTS + 1) p.mixer.push(createInsert(p.mixer.length));
  p.clips = (raw.clips ?? []).filter((c: any) => c && typeof c.start === 'number');
  p.userPlugins = raw.userPlugins ?? [];
  p.liveCode = typeof raw.liveCode === 'string' ? raw.liveCode : base.liveCode;
  p.bpm = Number(raw.bpm) || 120;
  p.beatsPerBar = Number(raw.beatsPerBar) || 4;
  p.swing = Number(raw.swing) || 0;
  return p;
}
