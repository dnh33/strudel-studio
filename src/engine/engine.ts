// The Strudel engine wrapper: one Strudel REPL (scheduler + superdough) driven by generated code.

import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { transpiler } from '@strudel/transpiler';
import { registerSoundfonts } from '@strudel/soundfonts';
import type { Channel, PlayMode, Project } from '../model/types';
import { compileProject } from '../model/compile';
import { initPlugins, getPluginInfo } from '../plugins/registry';
import { MixerGraph } from './graph';
import { SAMPLE_MAPS, type SampleMap } from './library';
import { encodeWav } from './wav';
import { midiToStrudel } from '../model/util';
import { loadUserSamples, type UserSample } from './userSamples';
import { registerNativeSound, beginNativeRender, finishNativeRender } from '../native/nativeStudio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const {
  getAudioContext,
  setAudioContext,
  getSuperdoughAudioController,
  setSuperdoughAudioController,
  initAudio,
  superdough,
  samples,
  aliasBank,
  registerSynthSounds,
  registerZZFXSounds,
  registerSound,
  webaudioRepl,
  soundMap,
  setMaxPolyphony,
} = webaudio as Any;

export interface Trigger {
  color: string;
  time: number; // audio context time of onset
  dur: number;
  note?: number;
}

export interface TransportState {
  mode: PlayMode;
  startBar: number;
  loop: { start: number; end: number } | null;
  patternBars: number;
  songBars: number;
}

export type EngineEvent =
  | { type: 'status'; status: EngineStatus; message?: string }
  | { type: 'playing'; playing: boolean }
  | { type: 'error'; message: string | null }
  | { type: 'log'; message: string; level: 'info' | 'warning' | 'error' }
  | { type: 'samples'; maps: Record<string, SampleMap> }
  | { type: 'userSamples'; samples: UserSample[] }
  | { type: 'evaluated'; code: string; miniLocations: [number, number][] };

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface RenderOptions {
  code: string;
  project: Project;
  startBar: number;
  bars: number;
  tailSeconds?: number;
  sampleRate?: number;
  onProgress?: (msg: string, frac: number) => void;
}

class Engine {
  status: EngineStatus = 'idle';
  ctx!: AudioContext;
  repl: Any;
  graph!: MixerGraph;
  sampleMaps: Record<string, SampleMap> = {};
  userSamples: UserSample[] = [];
  playing = false;
  lastError: string | null = null;
  scopeNames = new Set<string>();
  lastEvaluated: { code: string; miniLocations: [number, number][] } = { code: '', miniLocations: [] };

  private readyPromise: Promise<void> | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();
  private rawPattern: Any = null;
  private transport: TransportState = { mode: 'pattern', startBar: 0, loop: null, patternBars: 1, songBars: 1 };
  private playOffset = 0; // bar where the current playback started (relative position math)
  private triggers: Trigger[] = [];
  private lastCode = '';
  private pendingCode: string | null = null;
  private evaluating = false;
  private project: Project | null = null;
  private previewCache = new Map<string, Any>();
  private rendering = false;
  private inflight = new Set<Promise<unknown>>();

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit(e: EngineEvent) {
    this.listeners.forEach((f) => f(e));
  }

  /** initialise lazily (AudioContext needs a user gesture to start) */
  init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInit().catch((err) => {
      console.error(err);
      this.status = 'failed';
      this.emit({ type: 'status', status: 'failed', message: String(err?.message ?? err) });
      throw err;
    });
    return this.readyPromise;
  }

  private async doInit() {
    this.status = 'loading';
    this.emit({ type: 'status', status: 'loading', message: 'Starting audio engine…' });
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    setAudioContext(this.ctx);
    (globalThis as Any).__studioAudioCtx = this.ctx;

    document.addEventListener('strudel.log', (e: Any) => {
      const { message, type } = e.detail ?? {};
      if (!message) return;
      const level = type === 'error' || /error/i.test(message) ? 'error' : type === 'warning' ? 'warning' : 'info';
      this.emit({ type: 'log', message, level });
    });

    const scope = await core.evalScope(core, mini, tonal, webaudio, {
      registerSound,
      getAudioContext,
    });
    for (const mod of scope as Any[]) Object.keys(mod ?? {}).forEach((k) => this.scopeNames.add(k));
    (mini as Any).miniAllStrings();

    this.repl = webaudioRepl({
      transpiler,
      defaultOutput: (hap: Any, deadline: number, duration: number, cps: number, t: number) => {
        const v = hap.value;
        if (this.rendering) return; // never touch the realtime graph while the global context is swapped
        if (v && typeof v === 'object' && v.color) this.pushTrigger({ color: v.color, time: t, dur: duration });
        return this.track(webaudio.webaudioOutput(hap, deadline, duration, cps, t));
      },
      editPattern: (pat: Any) => {
        this.rawPattern = pat;
        return this.transformPattern(pat);
      },
      onToggle: (started: boolean) => {
        this.playing = started;
        this.emit({ type: 'playing', playing: started });
      },
      afterEval: ({ code, meta }: Any) => {
        this.lastEvaluated = { code, miniLocations: meta?.miniLocations ?? [] };
        this.emit({ type: 'evaluated', code, miniLocations: this.lastEvaluated.miniLocations });
      },
      onUpdateState: (state: Any) => {
        const msg = state.error ? String(state.error.message ?? state.error) : null;
        if (msg !== this.lastError) {
          this.lastError = msg;
          this.emit({ type: 'error', message: msg });
        }
      },
    });
    // expose repl helpers (setcpm etc.) by running one evaluation
    await this.repl.evaluate('silence', false);

    registerSynthSounds();
    registerZZFXSounds();
    registerSoundfonts();
    initPlugins({ registerSound, registerControl: core.registerControl, getAudioContext });
    // VST3 channels (native app): .s("native").vst(channelId)
    registerNativeSound({ registerSound, registerControl: core.registerControl, getAudioContext, getSound: (n: string) => soundMap.get()[n] });

    this.graph = new MixerGraph(this.ctx, getSuperdoughAudioController(), true);
    if (this.project) this.graph.sync(this.project);

    this.emit({ type: 'status', status: 'loading', message: 'Loading sample libraries…' });
    await this.loadSampleMaps();
    try {
      this.userSamples = await loadUserSamples((name, urls) => samples({ [name]: urls }));
      this.emit({ type: 'userSamples', samples: this.userSamples });
    } catch (e) {
      console.warn('user samples unavailable', e);
    }
    await initAudio({ maxPolyphony: 256 });
    this.status = 'ready';
    this.emit({ type: 'status', status: 'ready', message: 'Ready' });
  }

  private async loadSampleMaps() {
    const base = new URL('./samplemaps/', window.location.href).href;
    await Promise.all(
      SAMPLE_MAPS.map(async (m) => {
        try {
          const json = await fetch(base + m.file).then((r) => r.json());
          this.sampleMaps[m.file] = json;
          await samples(json, json._base, { prebake: true });
        } catch (e) {
          console.warn('could not load sample map', m.file, e);
        }
      }),
    );
    try {
      const alias = await fetch(base + 'tidal-drum-machines-alias.json').then((r) => r.json());
      aliasBank(alias);
    } catch {
      /* optional */
    }
    this.emit({ type: 'samples', maps: this.sampleMaps });
  }

  async resume() {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  // ------------------------------------------------------------------ project sync
  setProject(p: Project) {
    this.project = p;
    if (this.graph) this.graph.sync(p);
  }

  // ------------------------------------------------------------------ transport
  private transformPattern(pat: Any) {
    const t = this.transport;
    if (t.mode === 'song') {
      if (t.loop && t.loop.end > t.loop.start) {
        const len = t.loop.end - t.loop.start;
        const into = Math.max(0, Math.min(len, t.startBar - t.loop.start));
        let p = pat.ribbon(t.loop.start, len);
        if (into > 0 && into < len) p = p.early(into);
        return p;
      }
      return t.startBar > 0 ? pat.early(t.startBar) : pat;
    }
    return pat;
  }

  setTransport(t: Partial<TransportState>) {
    const prev = this.transport;
    this.transport = { ...this.transport, ...t };
    const changed =
      prev.mode !== this.transport.mode ||
      prev.startBar !== this.transport.startBar ||
      JSON.stringify(prev.loop) !== JSON.stringify(this.transport.loop);
    if (changed && this.rawPattern && this.playing) {
      // re-apply transformation to the running pattern
      this.repl.scheduler.setPattern(this.transformPattern(this.rawPattern), false);
    }
  }

  getTransport() {
    return this.transport;
  }

  /** current playhead position in bars (song or pattern position), null when stopped */
  position(): number | null {
    if (!this.playing || !this.repl) return null;
    const now = Math.max(0, this.repl.scheduler.now());
    const t = this.transport;
    if (t.mode === 'pattern') return now % Math.max(1, t.patternBars);
    if (t.mode === 'live') return now;
    if (t.loop && t.loop.end > t.loop.start) {
      const len = t.loop.end - t.loop.start;
      const into = Math.max(0, Math.min(len, t.startBar - t.loop.start));
      return t.loop.start + ((into + now) % len);
    }
    return (t.startBar + now) % Math.max(1, t.songBars);
  }

  /** haps sounding right now (for code highlighting) */
  activeHaps(): Any[] {
    const sch = this.repl?.scheduler;
    if (!this.playing || !sch?.pattern) return [];
    const now = Math.max(0, sch.now());
    try {
      return sch.pattern.queryArc(now, now + 1 / 120).filter((h: Any) => h.whole && h.whole.begin.valueOf() <= now + 1e-6);
    } catch {
      return [];
    }
  }

  cps(): number {
    return this.repl?.scheduler?.cps ?? 0.5;
  }

  async play(code: string, transport: Partial<TransportState>) {
    await this.resume();
    this.setTransport(transport);
    this.lastCode = code;
    this.triggers = [];
    await this.repl.evaluate(code, true);
    if (this.lastError) return false;
    return true;
  }

  /** hot-swap code while playing (debounced by caller) */
  async update(code: string, force = false) {
    if (!this.repl || (code === this.lastCode && !force)) return;
    this.lastCode = code;
    if (!this.playing) return;
    if (this.evaluating) {
      this.pendingCode = code;
      return;
    }
    this.evaluating = true;
    try {
      await this.repl.evaluate(code, false);
    } finally {
      this.evaluating = false;
      if (this.pendingCode) {
        const c = this.pendingCode;
        this.pendingCode = null;
        this.lastCode = '';
        await this.update(c);
      }
    }
  }

  /** restart from the transport's start bar (seek) */
  async restart() {
    if (!this.playing) return;
    this.repl.scheduler.stop();
    await this.repl.scheduler.start();
  }

  stop() {
    if (!this.repl) return;
    this.repl.scheduler.stop();
    this.triggers = [];
  }

  /** remember async superdough calls (sample loading) until they settle */
  private track<T>(p: Promise<T> | T): Promise<T> | T {
    if (p && typeof (p as Promise<T>).then === 'function') {
      const pr = p as Promise<T>;
      this.inflight.add(pr);
      pr.then(
        () => this.inflight.delete(pr),
        () => this.inflight.delete(pr),
      );
    }
    return p;
  }

  private async settle(timeoutMs = 8000) {
    const all = Promise.allSettled([...this.inflight]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  // ------------------------------------------------------------------ triggers (channel LEDs)
  private pushTrigger(t: Trigger) {
    this.triggers.push(t);
    if (this.triggers.length > 512) this.triggers.splice(0, this.triggers.length - 256);
  }
  /** triggers that sounded within the last `window` seconds */
  recentTriggers(window = 0.15): Trigger[] {
    if (!this.ctx) return [];
    const now = this.ctx.currentTime;
    return this.triggers.filter((t) => t.time <= now && now - t.time < Math.max(window, Math.min(t.dur, 0.4)));
  }

  // ------------------------------------------------------------------ meters
  meter(i: number) {
    return this.graph?.meter(i) ?? null;
  }
  scope(): AnalyserNode | null {
    return this.graph?.scope ?? null;
  }
  reduction(insert: number, slotId: string) {
    return this.graph?.reduction(insert, slotId) ?? 0;
  }

  // ------------------------------------------------------------------ code validation
  /** evaluates a snippet in isolation; returns an error message or null */
  async validateSnippet(code: string): Promise<string | null> {
    await this.init();
    try {
      const { pattern } = await core.evaluate(code, transpiler);
      if (!core.isPattern(pattern)) return 'Code must evaluate to a pattern (e.g. s("bd sd"))';
      pattern.queryArc(0, 1);
      return null;
    } catch (e: Any) {
      return String(e?.message ?? e);
    }
  }

  // ------------------------------------------------------------------ previews
  private async channelPreviewPattern(project: Project, ch: Channel, content: string) {
    const key = JSON.stringify([ch, project.mixer[ch.insert], project.bpm, content]);
    const cached = this.previewCache.get(key);
    if (cached) return cached;
    const mini: Project = { ...project, channels: [ch], clips: [], patterns: [] };
    const res = compileProject(mini, { mode: 'pattern', getPlugin: getPluginInfo, reservedNames: this.scopeNames });
    const id = res.channelIdents[ch.id];
    const code = `${res.preamble}\n${id}(${content})`;
    const { pattern } = await core.evaluate(code, transpiler);
    if (this.previewCache.size > 200) this.previewCache.clear();
    this.previewCache.set(key, pattern);
    return pattern;
  }

  /** audition a channel (piano roll keys, step clicks, browser) */
  async previewChannel(project: Project, ch: Channel, midi?: number, velocity = 1, seconds = 0.35) {
    try {
      await this.resume();
      let content: string;
      if (ch.kind === 'code') content = `(${ch.code})`;
      else if (ch.kind === 'sample' && midi === undefined) content = `s(${JSON.stringify(ch.sound)})`;
      else {
        const m = midi ?? ch.rootNote;
        const transposed = m + Math.round(ch.params.transpose ?? 0);
        content = `note("${midiToStrudel(transposed)}")${ch.kind === 'sample' ? `.s(${JSON.stringify(ch.sound)})` : ''}`;
      }
      const pat = await this.channelPreviewPattern(project, ch, content);
      const cps = this.cps() || project.bpm / project.beatsPerBar / 60;
      const t0 = this.ctx.currentTime + 0.03;
      const haps = pat.queryArc(0, ch.kind === 'code' ? 1 : 0.999).filter((h: Any) => h.hasOnset());
      for (const h of haps.slice(0, 64)) {
        const value = { ...h.value, velocity: (h.value.velocity ?? 1) * velocity };
        const begin = ch.kind === 'code' ? h.whole.begin.valueOf() / cps : 0;
        const dur = ch.kind === 'code' ? h.duration / cps : seconds;
        this.pushTrigger({ color: value.color, time: t0 + begin, dur });
        if (!this.rendering) this.track(superdough(value, t0 + begin, dur, cps));
      }
    } catch (e: Any) {
      this.emit({ type: 'log', message: 'Preview failed: ' + (e?.message ?? e), level: 'error' });
    }
  }

  /** play a raw sound (browser preview) */
  async previewSound(value: Record<string, unknown>, seconds = 0.8) {
    try {
      await this.resume();
      if (this.rendering) return;
      this.track(superdough({ gain: 0.8, orbit: 0, ...value }, this.ctx.currentTime + 0.03, seconds, this.cps()));
    } catch (e: Any) {
      this.emit({ type: 'log', message: 'Preview failed: ' + (e?.message ?? e), level: 'error' });
    }
  }

  // ------------------------------------------------------------------ offline render
  /**
   * Renders code to a WAV blob using an OfflineAudioContext (faster than realtime, sample accurate).
   * The native mixer graph (insert FX, faders, master limiter) is rebuilt on the offline context.
   */
  async renderWav(opts: RenderOptions & { bitDepth?: 16 | 24 | 32 }): Promise<Blob> {
    const buffer = await this.renderBuffer(opts);
    opts.onProgress?.('Encoding WAV…', 0.97);
    return encodeWav(buffer, opts.bitDepth ?? 16);
  }

  async renderBuffer(opts: RenderOptions): Promise<AudioBuffer> {
    await this.init();
    if (this.rendering) throw new Error('Already rendering');
    this.rendering = true;
    const wasPlaying = this.playing;
    this.stop();
    // let triggers that are still loading samples finish on the realtime context first
    await this.settle();
    const realCtx = this.ctx;
    const realController = getSuperdoughAudioController();
    const sr = opts.sampleRate ?? 44100;
    let graph: MixerGraph | null = null;
    try {
      opts.onProgress?.('Evaluating code…', 0.02);
      const prevTransport = this.transport;
      this.transport = { ...prevTransport, mode: 'pattern' }; // no transform, we offset manually
      await this.repl.evaluate(opts.code, false);
      this.transport = prevTransport;
      if (this.lastError) throw new Error(this.lastError);
      const pattern = this.rawPattern;
      const cps = this.repl.scheduler.cps;
      const seconds = opts.bars / cps + (opts.tailSeconds ?? 2);
      const offline = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
      setAudioContext(offline);
      (globalThis as Any).__studioAudioCtx = offline;
      setSuperdoughAudioController(null);
      const controller = getSuperdoughAudioController();
      await initAudio({ maxPolyphony: 4096 });
      graph = new MixerGraph(offline, controller, false);
      graph.sync(opts.project);
      const haps = pattern
        .queryArc(opts.startBar, opts.startBar + opts.bars, { _cps: cps })
        .filter((h: Any) => h.hasOnset())
        .sort((a: Any, b: Any) => a.whole.begin.valueOf() - b.whole.begin.valueOf());
      beginNativeRender();
      let i = 0;
      for (const hap of haps) {
        i++;
        if (i % 50 === 0) opts.onProgress?.(`Scheduling ${i}/${haps.length} events…`, 0.05 + 0.45 * (i / haps.length));
        try {
          hap.ensureObjectValue?.();
          const begin = hap.whole.begin.valueOf();
          await superdough({ ...hap.value }, (begin - opts.startBar) / cps, hap.duration / cps, cps, begin);
        } catch (e) {
          console.warn('render: event failed', e);
        }
      }
      opts.onProgress?.(`Rendering ${seconds.toFixed(1)}s of audio…`, 0.55);
      const buffer = await offline.startRendering();
      // let queued 'ended' events of offline voices run while the offline context is still active
      await new Promise((r) => setTimeout(r, 120));
      // VST3 channels are rendered by the native app and mixed in
      await finishNativeRender(buffer, { startBar: opts.startBar, bpm: cps * 60 * opts.project.beatsPerBar, beatsPerBar: opts.project.beatsPerBar, onProgress: opts.onProgress });
      return buffer;
    } finally {
      graph?.dispose();
      setAudioContext(realCtx);
      (globalThis as Any).__studioAudioCtx = realCtx;
      setSuperdoughAudioController(realController);
      setMaxPolyphony(256);
      this.rendering = false;
      this.lastCode = '';
      if (wasPlaying) this.emit({ type: 'playing', playing: false });
    }
  }

  // ------------------------------------------------------------------ misc
  hasSound(name: string) {
    return !!soundMap.get()[name.toLowerCase()];
  }

  registerUserSample(name: string, urls: string[]) {
    samples({ [name]: urls });
  }

  setUserSamples(list: UserSample[]) {
    this.userSamples = list;
    this.emit({ type: 'userSamples', samples: list });
  }
}

export const engine = new Engine();
// handy for debugging from the devtools console
(globalThis as Any).studioEngine = engine;
