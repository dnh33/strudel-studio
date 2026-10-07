// Bridge to the Strudel Studio native app (JUCE). In a normal browser `isNative` is false and
// everything here is a harmless no-op, so the web app keeps working on its own.
//
// Native functions are JUCE WebView "native functions" (see native/Source/StudioWebView.cpp):
//   window.__JUCE__.backend.emitEvent('__juce__invoke', { name, params, resultId })
//   -> the backend answers with the '__juce__complete' event { promiseId, result }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface NativeAudioInfo {
  type: string;
  device: string;
  sampleRate: number;
  bufferSize: number;
  latencyMs: number;
  running: boolean;
  cpu: number;
  syncOffsetMs: number;
  midiInputs: string[];
}

export interface NativeHello {
  app: string;
  version: string;
  juce: string;
  os: string;
  platform: 'windows' | 'mac' | 'linux';
  dataFolder: string;
  webRoot: string;
  resourceRoot: string;
  clock: number;
  audio: NativeAudioInfo;
  syncOffsetMs: number;
  pluginCount: number;
  scanning: boolean;
  defaultPluginFolders: string[];
  openPath: string;
}

export interface NativePlugin {
  id: string;
  name: string;
  vendor: string;
  category: string;
  format: string;
  isInstrument: boolean;
  inputs: number;
  outputs: number;
  version: string;
  file: string;
}

export interface NativeSlotStatus {
  slot: string;
  plugin: string;
  name: string;
  error: string;
  loaded: boolean;
  hasEditor: boolean;
  latency: number;
  bypass: boolean;
}

export interface NativeTrackStatus {
  id: string;
  instrument: NativeSlotStatus | null;
  fx: NativeSlotStatus[];
}

export interface NativeTrackSpec {
  id: string;
  instrument: string;
  fx: { slot: string; plugin: string; bypass: boolean }[];
  volume: number;
  pan: number; // -1..1
  mute: boolean;
}

export interface NativeNote {
  t: string; // track (channel) id
  n: number; // midi note
  v: number; // velocity 0..1
  at: number; // realtime: native clock ms (heard time) · offline: ms from render start
  d: number; // duration ms
}

export interface NativeMidiEvent {
  type: 'on' | 'off' | 'cc' | 'pitch';
  note: number;
  value: number;
  channel: number;
  device: string;
  time: number;
}

export interface NativeMeters {
  master: [number, number];
  tracks: Record<string, [number, number]>;
  cpu: number;
}

const w = globalThis as Any;
const backend = w.__JUCE__?.backend;
export const isNative = !!(w.__STRUDEL_STUDIO_NATIVE__ && backend);
export const resourceRoot: string = w.__STRUDEL_STUDIO_NATIVE__?.resourceRoot ?? '';

// Messages to the backend are sent ASCII-only (non-ASCII as JSON \\u escapes): the Linux WebView backend
// of JUCE decodes them as Latin-1 otherwise. Harmless everywhere else.
if (isNative && typeof w.__JUCE__.postMessage === 'function' && !w.__JUCE__.__asciiSafe) {
  const post = w.__JUCE__.postMessage;
  w.__JUCE__.postMessage = function (this: Any, msg: Any) {
    const safe = typeof msg === 'string' ? msg.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : msg;
    return post.call(this, safe);
  };
  w.__JUCE__.__asciiSafe = true;
}

// ------------------------------------------------------------------ calls
let nextId = 1;
const pending = new Map<number, (v: Any) => void>();
if (isNative) {
  backend.addEventListener('__juce__complete', (payload: Any) => {
    const r = pending.get(payload?.promiseId);
    if (r) {
      pending.delete(payload.promiseId);
      r(payload.result);
    }
  });
}

export function call<T = Any>(name: string, ...params: Any[]): Promise<T> {
  if (!isNative) return Promise.reject(new Error('Not running in the Strudel Studio native app'));
  return new Promise<T>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    backend.emitEvent('__juce__invoke', { name, params, resultId: id });
  });
}

/** fire-and-forget (result ignored) */
function send(name: string, ...params: Any[]) {
  if (isNative) call(name, ...params).catch(() => {});
}

export function onNative<T = Any>(eventId: string, fn: (payload: T) => void): () => void {
  if (!isNative) return () => {};
  const token = backend.addEventListener(eventId, fn);
  return () => backend.removeEventListener(token);
}

// ------------------------------------------------------------------ clock
// native clock (ms) = performance.now() + clockOffset
let clockOffset = 0;
let clockSynced = false;

export async function syncClock(rounds = 6) {
  if (!isNative) return;
  let bestRtt = Infinity;
  let best = 0;
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    const n = await call<number>('ss_clock');
    const t1 = performance.now();
    if (t1 - t0 < bestRtt) {
      bestRtt = t1 - t0;
      best = n - (t0 + t1) / 2;
    }
  }
  clockOffset = clockSynced ? clockOffset * 0.5 + best * 0.5 : best;
  clockSynced = true;
}

/** AudioContext time (s) -> native clock (ms) of the moment it is heard */
export function ctxTimeToNative(ctx: BaseAudioContext, t: number): number {
  const ac = ctx as AudioContext;
  // estimate from currentTime + reported latency...
  const lat = (ac.outputLatency || ac.baseLatency || 0.02) * 1000;
  const estimate = performance.now() + (t - ac.currentTime) * 1000 + lat;
  // ...refined by the output timestamp (when the browser reports a plausible one)
  const ts = typeof ac.getOutputTimestamp === 'function' ? ac.getOutputTimestamp() : null;
  if (ts && ts.performanceTime && ts.contextTime) {
    const heard = ts.performanceTime + (t - ts.contextTime) * 1000;
    if (Math.abs(heard - estimate) < 250) return heard + clockOffset;
  }
  return estimate + clockOffset;
}

export const nativeNow = () => performance.now() + clockOffset;

// ------------------------------------------------------------------ notes
let queue: NativeNote[] = [];
let flushScheduled = false;
function flush() {
  flushScheduled = false;
  if (!queue.length) return;
  const q = queue;
  queue = [];
  send('ss_notes', q);
}

export function queueNote(n: NativeNote) {
  queue.push(n);
  if (queue.length >= 256) flush();
  else if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
}

// ------------------------------------------------------------------ API
export const native = {
  hello: () => call<NativeHello>('ss_hello'),
  audioInfo: () => call<NativeAudioInfo>('ss_audioInfo'),
  audioSettings: () => send('ss_audioSettings'),
  setSyncOffset: (ms: number) => call<number>('ss_setSyncOffset', ms),
  listPlugins: () => call<NativePlugin[]>('ss_listPlugins'),
  scanPlugins: (folders: string[], rescanAll = false) => call<boolean>('ss_scanPlugins', folders, rescanAll),
  syncTracks: (tracks: NativeTrackSpec[], master: number) => call<NativeTrackStatus[]>('ss_syncTracks', tracks, master),
  trackStatus: () => call<NativeTrackStatus[]>('ss_trackStatus'),
  openEditor: (track: string, slot: string, title: string, generic = false) => call<boolean>('ss_openEditor', track, slot, title, generic),
  closeEditor: (track: string, slot: string) => send('ss_closeEditor', track, slot),
  getState: () => call<Record<string, { plugin: string; state: string }>>('ss_getState'),
  setState: (s: Record<string, { plugin: string; state: string }>) => call<boolean>('ss_setState', s),
  saveSession: () => send('ss_saveSession'),
  transport: (t: { playing: boolean; bpm: number; beatsPerBar: number; bar: number; at: number }) => send('ss_transport', t),
  panic: () => send('ss_panic'),
  liveNote: (track: string, note: number, velocity: number, on: boolean) => send('ss_liveNote', track, note, velocity, on),
  selectTrack: (track: string) => send('ss_selectTrack', track),
  render: (req: Any) => call<{ id?: string; url?: string; peak?: number; seconds?: number; sampleRate?: number; error?: string }>('ss_render', req),
  readRender: (id: string, offset: number, length: number) => call<string | null>('ss_readRender', id, offset, length),
  renderSize: (id: string) => call<number>('ss_renderSize', id),
  chooseFile: (o: { mode: 'open' | 'save'; title?: string; name?: string; filters?: string; folder?: string }) => call<string>('ss_chooseFile', o),
  readFile: (path: string, base64 = false) => call<string | null>('ss_readFile', path, base64),
  writeFile: (path: string, data: string, base64 = false, append = false) => call<boolean>('ss_writeFile', path, data, base64, append),
  fileInfo: (path: string) => call<{ exists: boolean; name: string; size: number; modified: number }>('ss_fileInfo', path),
  showInFolder: (path: string) => send('ss_showInFolder', path),
  openUrl: (url: string) => send('ss_openUrl', url),
  setTitle: (title: string) => send('ss_setTitle', title),
  quit: () => send('ss_quit'),
};

// ------------------------------------------------------------------ binary helpers
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** writes a (possibly large) binary file in chunks */
export async function writeBinaryFile(path: string, bytes: Uint8Array) {
  const CHUNK = 3 * 1024 * 1024;
  if (bytes.length === 0) return native.writeFile(path, '', true, false);
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const ok = await native.writeFile(path, bytesToBase64(bytes.subarray(off, off + CHUNK)), true, off > 0);
    if (!ok) return false;
  }
  return true;
}

/** fetches a rendered WAV from the native app (resource provider, with a chunked fallback) */
export async function fetchRender(id: string, url: string): Promise<ArrayBuffer> {
  try {
    const r = await fetch(resourceRoot + url);
    if (r.ok) {
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 44) return buf;
    }
  } catch {
    /* fall back below */
  }
  const size = await native.renderSize(id);
  if (size < 0) throw new Error('native render not found');
  const out = new Uint8Array(size);
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < size; off += CHUNK) {
    const part = await native.readRender(id, off, CHUNK);
    if (part == null) throw new Error('native render could not be read');
    out.set(base64ToBytes(part), off);
  }
  return out.buffer;
}

/** parses a 32-bit float (or 16/24-bit PCM) WAV into channel arrays */
export function parseWav(buf: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const dv = new DataView(buf);
  let pos = 12;
  let fmt = { format: 3, channels: 2, sampleRate: 48000, bits: 32 };
  while (pos + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      const bytesPer = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, dv.byteLength - body) / (bytesPer * fmt.channels));
      const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (i * fmt.channels + c) * bytesPer;
          let v: number;
          if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
          else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
          else if (fmt.bits === 24) v = ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) as number) / 8388608;
          else v = dv.getInt32(o, true) / 2147483648;
          channels[c][i] = v;
        }
      }
      return { sampleRate: fmt.sampleRate, channels };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('invalid WAV data');
}
