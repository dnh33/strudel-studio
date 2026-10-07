// Glue between the studio (project store + Strudel engine) and the native app:
//  - the "native" Strudel sound: VST3 channels compile to .s("native").vst(channelId); this sound
//    forwards every note (with its exact timestamp) to the native engine
//  - keeps the native tracks (instrument + FX chain, volume, pan, mute) in sync with the project
//  - clock sync, transport, panic, MIDI input, plug-in list/scanning, plug-in states, offline render

import { create } from 'zustand';
import type { Channel, Project, VstSlot } from '../model/types';
import { getState, useStudio } from '../store/store';
import { uid } from '../model/util';
import {
  isNative,
  native,
  onNative,
  queueNote,
  syncClock,
  ctxTimeToNative,
  nativeNow,
  fetchRender,
  parseWav,
  type NativeAudioInfo,
  type NativeHello,
  type NativeMeters,
  type NativeMidiEvent,
  type NativeNote,
  type NativePlugin,
  type NativeTrackSpec,
  type NativeTrackStatus,
} from './bridge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export { isNative };

// ------------------------------------------------------------------ state
export interface NativeState {
  available: boolean;
  hello: NativeHello | null;
  audio: NativeAudioInfo | null;
  plugins: NativePlugin[];
  status: Record<string, NativeTrackStatus>;
  scanning: boolean;
  scanProgress: number;
  scanFile: string;
  editors: Record<string, boolean>; // "channelId|slotId" -> open
  syncOffsetMs: number;
  savePath: string | null; // project file path (native save)
  extraFolders: string[];
}

const FOLDERS_KEY = 'strudel-studio:vst-folders';
function loadFolders(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export const useNative = create<NativeState>(() => ({
  available: isNative,
  hello: null,
  audio: null,
  plugins: [],
  status: {},
  scanning: false,
  scanProgress: 0,
  scanFile: '',
  editors: {},
  syncOffsetMs: 0,
  savePath: null,
  extraFolders: loadFolders(),
}));

/** live meter values (not in the store to avoid re-renders) */
export const nativeMeters: { data: NativeMeters | null; time: number } = { data: null, time: 0 };

// ------------------------------------------------------------------ the "native" sound
let renderCollector: NativeNote[] | null = null;
let suppressUntil = 0;
/** diagnostics (tests / debugging) */
export const nativeStats = { sent: 0, lastAt: 0, lastSentAt: 0, collected: 0 };

const CHROMA: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export function valueToMidi(v: Any): number {
  if (typeof v.freq === 'number') return Math.round(69 + 12 * Math.log2(v.freq / 440));
  const n = v.note ?? v.n ?? 60;
  if (typeof n === 'number') return Math.round(n);
  const m = /^([a-gA-G])([#bsf]*)(-?\d*)$/.exec(String(n));
  if (!m) return 60;
  const acc = [...m[2]].reduce((a, c) => a + (c === '#' || c === 's' ? 1 : -1), 0);
  return (Number(m[3] === '' ? 3 : m[3]) + 1) * 12 + CHROMA[m[1].toLowerCase()] + acc;
}

interface SoundApi {
  registerSound: (name: string, fn: Any, data?: Any) => void;
  registerControl: (name: string) => Any;
  getAudioContext: () => BaseAudioContext;
  getSound: (name: string) => Any;
}

/** registers the "native" sound + the .vst() control (in the browser it plays a stand-in synth) */
export function registerNativeSound(api: SoundApi) {
  try {
    api.registerControl('vst');
  } catch {
    /* already registered */
  }
  api.registerSound(
    'native',
    (t: number, value: Any, onended: () => void, cps: number) => {
      const ac = api.getAudioContext();
      const track = value.vst != null ? String(value.vst) : '';
      const n = Math.max(0, Math.min(127, valueToMidi(value)));
      const v = Math.max(0, Math.min(1, value.velocity ?? 1));
      const d = Math.max(0.005, value.duration ?? 0.25) * 1000;
      const offline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
      if (isNative && track) {
        // a late scheduler tick right after Stop must not start new notes
        if (!offline && performance.now() < suppressUntil) return undefined;
        if (offline) {
          renderCollector?.push({ t: track, n, v, at: t * 1000, d });
          nativeStats.collected++;
        } else {
          const at = ctxTimeToNative(ac, t);
          queueNote({ t: track, n, v, at, d });
          nativeStats.sent++;
          nativeStats.lastAt = at;
          nativeStats.lastSentAt = nativeNow();
        }
        return undefined; // no WebAudio nodes: the native engine plays it
      }
      // browser (or no track): stand-in synth so the part stays audible
      const fallback = api.getSound('triangle');
      return fallback?.onTrigger(t, { ...value, s: 'triangle', gain: (value.gain ?? 0.8) * 0.8 }, onended, cps);
    },
    { type: 'synth', prebake: true },
  );
}

// ------------------------------------------------------------------ project -> native tracks
function buildSpecs(p: Project): { specs: NativeTrackSpec[]; master: number } {
  const anyChSolo = p.channels.some((c) => c.solo);
  const anyInsSolo = p.mixer.some((m, i) => i > 0 && m.solo);
  const specs: NativeTrackSpec[] = [];
  for (const ch of p.channels) {
    if (ch.kind !== 'vst' || !ch.vst) continue;
    const insIdx = ch.insert > 0 && ch.insert < p.mixer.length ? ch.insert : 0;
    const ins = insIdx > 0 ? p.mixer[insIdx] : null;
    const insAudible = ins ? !ins.mute && (!anyInsSolo || ins.solo) : !anyInsSolo;
    const audible = !ch.mute && (!anyChSolo || ch.solo) && insAudible;
    const pan = Math.max(-1, Math.min(1, (ch.pan - 0.5) * 2 + (ins?.pan ?? 0)));
    specs.push({
      id: ch.id,
      instrument: ch.vst.pluginId,
      fx: ch.vst.fx.map((f) => ({ slot: f.id, plugin: f.pluginId, bypass: f.bypass })),
      volume: ch.volume * (ins ? ins.volume : 1),
      pan,
      mute: !audible,
    });
  }
  const m = p.mixer[0];
  return { specs, master: m ? (m.mute ? 0 : m.volume) : 1 };
}

let lastSpecJson = '';
let syncScheduled = false;
function scheduleTrackSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(async () => {
    syncScheduled = false;
    const { specs, master } = buildSpecs(getState().project);
    const json = JSON.stringify([specs, master]);
    if (json === lastSpecJson) return;
    lastSpecJson = json;
    try {
      const status = await native.syncTracks(specs, master);
      setStatus(status);
    } catch (e) {
      console.warn('native sync failed', e);
    }
  });
}

function setStatus(list: NativeTrackStatus[]) {
  const status: Record<string, NativeTrackStatus> = {};
  for (const t of list ?? []) status[t.id] = t;
  useNative.setState({ status });
  for (const t of list ?? []) {
    for (const s of [t.instrument, ...t.fx]) {
      if (s?.error) getState().log(`VST3: ${s.error}`, 'warning');
    }
  }
}

// ------------------------------------------------------------------ plug-in states
export async function applyProjectStates(p: Project) {
  if (!isNative) return;
  if (p.nativeStates && Object.keys(p.nativeStates).length) await native.setState(p.nativeStates);
  lastSpecJson = '';
  scheduleTrackSync();
}

/** project with the current plug-in states embedded (for saving) */
export async function projectWithStates(p: Project): Promise<Project> {
  if (!isNative || !p.channels.some((c) => c.kind === 'vst')) return p;
  try {
    const all = await native.getState();
    const ids = new Set(p.channels.filter((c) => c.kind === 'vst').map((c) => c.id));
    const nativeStates: NonNullable<Project['nativeStates']> = {};
    for (const [k, v] of Object.entries(all ?? {})) if (ids.has(k.split('|')[0])) nativeStates[k] = v;
    return { ...p, nativeStates };
  } catch {
    return p;
  }
}

// ------------------------------------------------------------------ transport
let transportTimer: ReturnType<typeof setInterval> | null = null;
async function sendTransport(playing: boolean) {
  const { engine } = await import('../engine/engine');
  const p = getState().project;
  const ctx = engine.ctx;
  const bar = engine.position() ?? getState().startBar;
  const at = ctx ? ctxTimeToNative(ctx, ctx.currentTime) : nativeNow();
  native.transport({ playing, bpm: p.bpm, beatsPerBar: p.beatsPerBar, bar, at });
}

// ------------------------------------------------------------------ offline render
/** call before scheduling the offline render's events */
export function beginNativeRender() {
  renderCollector = isNative ? [] : null;
}

/** renders the collected VST3 notes natively and mixes them into `buffer` */
export async function finishNativeRender(
  buffer: AudioBuffer,
  opts: { startBar: number; bpm: number; beatsPerBar: number; onProgress?: (msg: string, frac: number) => void },
) {
  const events = renderCollector;
  renderCollector = null;
  if (!isNative || !events || !events.length) return;
  opts.onProgress?.(`Rendering VST3 plug-ins (${events.length} notes)…`, 0.9);
  const r = await native.render({
    sampleRate: buffer.sampleRate,
    seconds: buffer.duration,
    bpm: opts.bpm,
    beatsPerBar: opts.beatsPerBar,
    startBar: opts.startBar,
    events,
  });
  if (!r || r.error || !r.url || !r.id) throw new Error('VST3 render failed: ' + (r?.error ?? 'unknown error'));
  const wav = parseWav(await fetchRender(r.id, r.url));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = wav.channels[Math.min(c, wav.channels.length - 1)];
    const dst = buffer.getChannelData(c);
    const n = Math.min(src.length, dst.length);
    for (let i = 0; i < n; i++) dst[i] += src[i];
  }
}

// ------------------------------------------------------------------ plug-ins
export async function refreshPlugins() {
  if (!isNative) return;
  const plugins = await native.listPlugins();
  useNative.setState({ plugins: [...plugins].sort((a, b) => a.name.localeCompare(b.name)) });
}

export function scanPlugins(rescanAll = false) {
  if (!isNative) return;
  useNative.setState({ scanning: true, scanProgress: 0, scanFile: '' });
  native.scanPlugins(useNative.getState().extraFolders, rescanAll);
}

export function setExtraFolders(folders: string[]) {
  useNative.setState({ extraFolders: folders });
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* ignore */
  }
}

export function pluginById(id: string) {
  return useNative.getState().plugins.find((p) => p.id === id);
}

export function openEditor(ch: Channel, slotId: string, generic = false) {
  if (!isNative) return;
  const slot = slotId === 'inst' ? ch.vst?.name : ch.vst?.fx.find((f) => f.id === slotId)?.name;
  native.openEditor(ch.id, slotId, `${slot ?? 'Plug-in'} — ${ch.name}`, generic);
}

export function newFxSlot(p: NativePlugin): VstSlot {
  return { id: uid('vfx'), pluginId: p.id, name: p.name, bypass: false };
}

export async function setSyncOffset(ms: number) {
  const v = await native.setSyncOffset(ms);
  useNative.setState({ syncOffsetMs: v });
}

// ------------------------------------------------------------------ MIDI
type MidiHandler = (e: NativeMidiEvent) => void;
let midiHandler: MidiHandler | null = null;
export function setNativeMidiHandler(fn: MidiHandler) {
  midiHandler = fn;
}

// ------------------------------------------------------------------ init
let started = false;
let selectedTrack = '';
export async function initNative() {
  if (!isNative || started) return;
  started = true;

  onNative<NativeTrackStatus[]>('ss_status', setStatus);
  onNative<NativeMeters>('ss_meters', (m) => {
    nativeMeters.data = m;
    nativeMeters.time = performance.now();
  });
  onNative<NativeAudioInfo>('ss_audio', (a) => useNative.setState({ audio: a }));
  onNative<NativeMidiEvent>('ss_midi', (e) => midiHandler?.(e));
  onNative<{ progress: number; file: string }>('ss_scanProgress', (e) => useNative.setState({ scanning: true, scanProgress: e.progress, scanFile: e.file }));
  onNative<{ count: number; failed: string[]; plugins: NativePlugin[] }>('ss_scanFinished', (e) => {
    useNative.setState({ scanning: false, scanProgress: 1, scanFile: '', plugins: [...e.plugins].sort((a, b) => a.name.localeCompare(b.name)) });
    getState().log(`VST3 scan finished: ${e.count} plug-in${e.count === 1 ? '' : 's'}${e.failed.length ? `, ${e.failed.length} failed` : ''}`);
    e.failed.forEach((f) => getState().log(`VST3 scan failed: ${f}`, 'warning'));
    getState().setHint(`VST3 scan finished: ${e.count} plug-ins`);
  });
  onNative<{ track: string; slot: string; open: boolean }>('ss_editor', (e) =>
    useNative.setState((s) => ({ editors: { ...s.editors, [`${e.track}|${e.slot}`]: e.open } })),
  );
  onNative<string>('ss_openPath', (path) => openNativePath(path));

  const hello = await native.hello();
  useNative.setState({ hello, audio: hello.audio, syncOffsetMs: hello.syncOffsetMs, scanning: hello.scanning });
  getState().log(`Native app ${hello.version} · JUCE ${hello.juce.replace(/^JUCE v/, '')} · ${hello.audio.type}: ${hello.audio.device || 'no device'}`);
  await syncClock();
  setInterval(() => syncClock(3).catch(() => {}), 10000);
  await refreshPlugins();

  // project -> native tracks
  scheduleTrackSync();
  useStudio.subscribe((s, prev) => {
    if (s.project !== prev.project) scheduleTrackSync();
    if (s.channelId !== prev.channelId || s.project.channels !== prev.project.channels) {
      const ch = s.project.channels.find((c) => c.id === s.channelId);
      const sel = ch?.kind === 'vst' ? ch.id : '';
      if (sel !== selectedTrack) native.selectTrack((selectedTrack = sel));
    }
    if (s.playing !== prev.playing) {
      if (s.playing) {
        sendTransport(true);
        transportTimer = setInterval(() => sendTransport(true), 1000);
      } else {
        if (transportTimer) clearInterval(transportTimer);
        transportTimer = null;
        native.transport({ playing: false, bpm: s.project.bpm, beatsPerBar: s.project.beatsPerBar, bar: s.startBar, at: nativeNow() });
        native.panic();
        suppressUntil = performance.now() + 200;
      }
    }
    if (s.project.name !== prev.project.name || s.dirty !== prev.dirty) native.setTitle(s.project.name + (s.dirty ? ' •' : ''));
  });
  native.setTitle(getState().project.name);
  const ch = getState().project.channels.find((c) => c.id === getState().channelId);
  selectedTrack = ch?.kind === 'vst' ? ch.id : '';
  native.selectTrack(selectedTrack);

  if (hello.openPath && /\.json$/i.test(hello.openPath)) openNativePath(hello.openPath);
  // first run: offer a scan
  if (!hello.pluginCount && !hello.scanning) getState().setHint('No VST3 plug-ins known yet — use Browser → VST3 → Scan (or File → Scan VST3 plug-ins).');
}

async function openNativePath(path: string) {
  const text = await native.readFile(path);
  if (!text) return;
  try {
    const { loadProjectGuarded } = await import('../ui/fileio');
    loadProjectGuarded(JSON.parse(text), path.split(/[\\/]/).pop() ?? path, path);
  } catch (e) {
    getState().log(`Could not open ${path}: ${(e as Error).message}`, 'error');
  }
}

// ------------------------------------------------------------------ live notes (keyboard / piano roll)
export function liveNote(ch: Channel, midi: number, velocity: number, on: boolean) {
  if (!isNative || ch.kind !== 'vst') return false;
  native.liveNote(ch.id, midi, velocity, on);
  return true;
}
