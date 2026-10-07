// Native mixer graph: every mixer insert owns one superdough "orbit". We re-route each orbit's
// output through our own insert strip (FX slots -> pan -> fader -> mute) into the master strip.

import type { FxSlot, Project } from '../model/types';
import { createEffect, type EffectInstance } from '../plugins/effects';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SuperdoughController = any;

class FxChain {
  input: GainNode;
  output: GainNode;
  private items: { id: string; pluginId: string; inst: EffectInstance }[] = [];
  private sig = '';
  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }
  sync(slots: FxSlot[], bpm: number) {
    const sig = slots.map((s) => s.id + ':' + s.pluginId).join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      const old = new Map(this.items.map((i) => [i.id, i]));
      this.input.disconnect();
      this.items.forEach((i) => i.inst.output.disconnect());
      const next: typeof this.items = [];
      for (const s of slots) {
        const prev = old.get(s.id);
        if (prev && prev.pluginId === s.pluginId) {
          next.push(prev);
          old.delete(s.id);
        } else {
          const inst = createEffect(this.ctx, s.pluginId);
          if (inst) next.push({ id: s.id, pluginId: s.pluginId, inst });
        }
      }
      old.forEach((o) => o.inst.dispose());
      this.items = next;
      let node: AudioNode = this.input;
      for (const it of this.items) {
        node.connect(it.inst.input);
        node = it.inst.output;
      }
      node.connect(this.output);
    }
    for (const it of this.items) {
      const s = slots.find((x) => x.id === it.id);
      if (s) it.inst.update(s.params, s.mix, s.enabled, { bpm });
    }
  }
  reduction(slotId: string) {
    return this.items.find((i) => i.id === slotId)?.inst.meter?.() ?? 0;
  }
  dispose() {
    this.items.forEach((i) => i.inst.dispose());
    this.items = [];
  }
}

export interface Strip {
  input: GainNode;
  fx: FxChain;
  panner: StereoPannerNode;
  fader: GainNode;
  mute: GainNode;
  output: GainNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
}

function createStrip(ctx: BaseAudioContext, withMeters: boolean): Strip {
  const input = ctx.createGain();
  const fx = new FxChain(ctx);
  const panner = ctx.createStereoPanner();
  const fader = ctx.createGain();
  const mute = ctx.createGain();
  const output = ctx.createGain();
  input.connect(fx.input);
  fx.output.connect(panner).connect(fader).connect(mute).connect(output);
  const analyserL = ctx.createAnalyser();
  const analyserR = ctx.createAnalyser();
  if (withMeters) {
    analyserL.fftSize = analyserR.fftSize = 1024;
    analyserL.smoothingTimeConstant = analyserR.smoothingTimeConstant = 0;
    const split = ctx.createChannelSplitter(2);
    output.connect(split);
    split.connect(analyserL, 0);
    split.connect(analyserR, 1);
  }
  return { input, fx, panner, fader, mute, output, analyserL, analyserR };
}

const setv = (ctx: BaseAudioContext, p: AudioParam, v: number) => {
  if (ctx instanceof AudioContext) p.setTargetAtTime(v, ctx.currentTime, 0.02);
  else p.value = v;
};

export class MixerGraph {
  master: Strip;
  scope: AnalyserNode;
  inserts = new Map<number, Strip>();
  private buf = new Float32Array(1024);
  constructor(
    private ctx: BaseAudioContext,
    private controller: SuperdoughController,
    private realtime: boolean,
  ) {
    this.master = createStrip(ctx, realtime);
    this.scope = ctx.createAnalyser();
    this.scope.fftSize = 2048;
    this.scope.smoothingTimeConstant = 0.75;
    if (realtime) this.master.output.connect(this.scope);
    this.master.output.connect(ctx.destination);
    // everything superdough outputs (incl. orbits we don't know about) goes through the master strip
    const dest = controller.output.destinationGain as GainNode;
    dest.disconnect();
    dest.connect(this.master.input);
  }

  /** makes sure superdough orbit `i` exists and is routed through insert strip `i` */
  ensureInsert(i: number): Strip {
    let s = this.inserts.get(i);
    if (s) return s;
    s = createStrip(this.ctx, this.realtime);
    s.output.connect(this.master.input);
    const orbit = this.controller.getOrbit(i, [0, 1]);
    try {
      orbit.output.disconnect();
    } catch {
      /* not connected */
    }
    orbit.output.connect(s.input);
    this.inserts.set(i, s);
    return s;
  }

  sync(project: Project) {
    const anySolo = project.mixer.some((m, i) => i > 0 && m.solo);
    for (let i = 0; i < project.mixer.length; i++) {
      const m = project.mixer[i];
      if (i === 0) {
        // master strip
        this.master.fx.sync(m.fx, project.bpm);
        setv(this.ctx, this.master.fader.gain, m.volume);
        setv(this.ctx, this.master.panner.pan, m.pan);
        setv(this.ctx, this.master.mute.gain, m.mute ? 0 : 1);
        // orbit 0 = channels routed directly to master
        const direct = this.ensureInsert(0);
        setv(this.ctx, direct.mute.gain, anySolo ? 0 : 1);
        continue;
      }
      const s = this.ensureInsert(i);
      s.fx.sync(m.fx, project.bpm);
      setv(this.ctx, s.fader.gain, m.volume);
      setv(this.ctx, s.panner.pan, m.pan);
      const audible = !m.mute && (!anySolo || m.solo);
      setv(this.ctx, s.mute.gain, audible ? 1 : 0);
    }
  }

  private level(a: AnalyserNode) {
    const b = this.buf;
    a.getFloatTimeDomainData(b);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < b.length; i++) {
      const v = Math.abs(b[i]);
      if (v > peak) peak = v;
      sum += b[i] * b[i];
    }
    return { peak, rms: Math.sqrt(sum / b.length) };
  }

  meter(i: number) {
    const s = i === 0 ? this.master : this.inserts.get(i);
    if (!s) return null;
    return { l: this.level(s.analyserL), r: this.level(s.analyserR) };
  }

  reduction(i: number, slotId: string) {
    const s = i === 0 ? this.master : this.inserts.get(i);
    return s?.fx.reduction(slotId) ?? 0;
  }

  dispose() {
    this.inserts.forEach((s) => s.fx.dispose());
    this.master.fx.dispose();
    try {
      this.master.output.disconnect();
    } catch {
      /* ignore */
    }
  }
}
