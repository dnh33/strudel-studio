// Native (WebAudio) insert effects for the mixer — the "effect VSTs" of Strudel Studio.
// Each effect builds its own node graph on any BaseAudioContext (realtime or offline),
// so exports render exactly what you hear.

import type { ParamDef } from '../model/paramDefs';

export interface EffectContext {
  bpm: number;
}

export interface EffectInstance {
  input: AudioNode;
  output: AudioNode;
  update(params: Record<string, number>, mix: number, enabled: boolean, info: EffectContext): void;
  dispose(): void;
  /** optional analysis (e.g. gain reduction) for UI */
  meter?: () => number;
}

export interface EffectDef {
  id: string;
  name: string;
  description: string;
  params: ParamDef[];
  create(ctx: BaseAudioContext): EffectCore;
}

/** effect core: wet path only; the wrapper handles dry/wet + bypass */
export interface EffectCore {
  input: AudioNode;
  output: AudioNode;
  set(p: Record<string, number>, info: EffectContext): void;
  nodes: AudioNode[];
  stop?: () => void;
  meter?: () => number;
}

const P = (key: string, label: string, min: number, max: number, def: number, extra: Partial<ParamDef> = {}): ParamDef => ({
  key, label, group: 'fx', min, max, def, control: key, ...extra,
});

const val = (p: Record<string, number>, def: ParamDef[], key: string) => p[key] ?? def.find((d) => d.key === key)!.def;

const setParam = (param: AudioParam, v: number, ctx: BaseAudioContext) => {
  if (!isFinite(v)) return;
  // small smoothing to avoid zipper noise in realtime
  if (ctx instanceof AudioContext) param.setTargetAtTime(v, ctx.currentTime, 0.015);
  else param.value = v;
};

function makeCurve(fn: (x: number) => number, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

function impulse(ctx: BaseAudioContext, seconds: number, decay: number, damp: number) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const n = Math.random() * 2 - 1;
      // progressively darker tail
      const a = 1 - damp * t * 0.95;
      lp = lp + (n - lp) * Math.max(0.02, a);
      d[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

const EQ3: EffectDef = {
  id: 'eq3',
  name: 'EQ 3-Band',
  description: 'Low shelf, parametric mid and high shelf equalizer',
  params: [
    P('low', 'Low', -18, 18, 0, { unit: 'dB' }),
    P('lowf', 'Low Freq', 40, 600, 180, { unit: 'Hz', curve: 'log' }),
    P('mid', 'Mid', -18, 18, 0, { unit: 'dB' }),
    P('midf', 'Mid Freq', 200, 8000, 1200, { unit: 'Hz', curve: 'log' }),
    P('q', 'Mid Q', 0.2, 8, 0.9, { curve: 'log' }),
    P('high', 'High', -18, 18, 0, { unit: 'dB' }),
    P('highf', 'High Freq', 1500, 16000, 6000, { unit: 'Hz', curve: 'log' }),
  ],
  create(ctx) {
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowshelf';
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    const hi = ctx.createBiquadFilter();
    hi.type = 'highshelf';
    lo.connect(mid).connect(hi);
    const d = EQ3.params;
    return {
      input: lo,
      output: hi,
      nodes: [lo, mid, hi],
      set(p) {
        setParam(lo.gain, val(p, d, 'low'), ctx);
        setParam(lo.frequency, val(p, d, 'lowf'), ctx);
        setParam(mid.gain, val(p, d, 'mid'), ctx);
        setParam(mid.frequency, val(p, d, 'midf'), ctx);
        setParam(mid.Q, val(p, d, 'q'), ctx);
        setParam(hi.gain, val(p, d, 'high'), ctx);
        setParam(hi.frequency, val(p, d, 'highf'), ctx);
      },
    };
  },
};

const COMPRESSOR: EffectDef = {
  id: 'compressor',
  name: 'Compressor',
  description: 'Dynamics compressor with makeup gain',
  params: [
    P('threshold', 'Threshold', -60, 0, -18, { unit: 'dB' }),
    P('ratio', 'Ratio', 1, 20, 4, { curve: 'exp' }),
    P('attack', 'Attack', 0.001, 0.3, 0.01, { unit: 's', curve: 'log' }),
    P('release', 'Release', 0.01, 1, 0.15, { unit: 's', curve: 'log' }),
    P('knee', 'Knee', 0, 40, 6, { unit: 'dB' }),
    P('makeup', 'Makeup', 0, 24, 3, { unit: 'dB' }),
  ],
  create(ctx) {
    const c = ctx.createDynamicsCompressor();
    const g = ctx.createGain();
    c.connect(g);
    const d = COMPRESSOR.params;
    return {
      input: c,
      output: g,
      nodes: [c, g],
      set(p) {
        setParam(c.threshold, val(p, d, 'threshold'), ctx);
        setParam(c.ratio, val(p, d, 'ratio'), ctx);
        setParam(c.attack, val(p, d, 'attack'), ctx);
        setParam(c.release, val(p, d, 'release'), ctx);
        setParam(c.knee, val(p, d, 'knee'), ctx);
        setParam(g.gain, Math.pow(10, val(p, d, 'makeup') / 20), ctx);
      },
      meter: () => c.reduction,
    };
  },
};

const LIMITER: EffectDef = {
  id: 'limiter',
  name: 'Limiter',
  description: 'Brickwall-style peak limiter to keep the master from clipping',
  params: [
    P('ceiling', 'Ceiling', -12, 0, -0.5, { unit: 'dB' }),
    P('gain', 'Input', 0, 18, 0, { unit: 'dB' }),
    P('release', 'Release', 0.01, 1, 0.12, { unit: 's', curve: 'log' }),
  ],
  create(ctx) {
    const pre = ctx.createGain();
    const c = ctx.createDynamicsCompressor();
    c.knee.value = 0;
    c.ratio.value = 20;
    c.attack.value = 0.001;
    // final soft clipper: transparent below ~-3 dB of the ceiling, never exceeds it
    const clip = ctx.createWaveShaper();
    clip.oversample = '4x';
    pre.connect(c).connect(clip);
    let lastCeil = NaN;
    const d = LIMITER.params;
    return {
      input: pre,
      output: clip,
      nodes: [pre, c, clip],
      set(p) {
        const ceil = val(p, d, 'ceiling');
        const lin = Math.pow(10, ceil / 20);
        if (ceil !== lastCeil) {
          const knee = lin * 0.7;
          clip.curve = makeCurve((x) => {
            const a = Math.abs(x) * 1.6; // curve input range covers ±1.6
            const y = a <= knee ? a : knee + (lin - knee) * Math.tanh((a - knee) / (lin - knee));
            return Math.sign(x) * Math.min(y, lin);
          }, 8192);
          lastCeil = ceil;
        }
        setParam(pre.gain, Math.pow(10, val(p, d, 'gain') / 20) / 1.6, ctx);
        setParam(c.threshold, ceil - 7, ctx); // input is pre-scaled by 1/1.6 (≈ -4 dB)
        setParam(c.release, val(p, d, 'release'), ctx);
      },
      meter: () => c.reduction,
    };
  },
};

const CHORUS: EffectDef = {
  id: 'chorus',
  name: 'Chorus',
  description: 'Stereo chorus with two modulated delay lines',
  params: [P('rate', 'Rate', 0.05, 5, 0.8, { unit: 'Hz', curve: 'log' }), P('depth', 'Depth', 0, 1, 0.5), P('delay', 'Delay', 0.005, 0.03, 0.015, { unit: 's' })],
  create(ctx) {
    const input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(0.1);
    const dr = ctx.createDelay(0.1);
    const lfoL = ctx.createOscillator();
    const lfoR = ctx.createOscillator();
    const gl = ctx.createGain();
    const gr = ctx.createGain();
    lfoL.connect(gl).connect(dl.delayTime);
    lfoR.connect(gr).connect(dr.delayTime);
    input.connect(split);
    split.connect(dl, 0);
    split.connect(dr, 1);
    dl.connect(merge, 0, 0);
    dr.connect(merge, 0, 1);
    lfoL.start();
    lfoR.start(ctx.currentTime + 0.25);
    const d = CHORUS.params;
    return {
      input,
      output: merge,
      nodes: [input, split, merge, dl, dr, lfoL, lfoR, gl, gr],
      stop: () => {
        lfoL.stop();
        lfoR.stop();
      },
      set(p) {
        const rate = val(p, d, 'rate');
        const depth = val(p, d, 'depth');
        const del = val(p, d, 'delay');
        setParam(lfoL.frequency, rate, ctx);
        setParam(lfoR.frequency, rate * 1.1, ctx);
        setParam(dl.delayTime, del, ctx);
        setParam(dr.delayTime, del * 1.2, ctx);
        setParam(gl.gain, depth * del * 0.8, ctx);
        setParam(gr.gain, depth * del * 0.8, ctx);
      },
    };
  },
};

const WIDTH: EffectDef = {
  id: 'width',
  name: 'Stereo Width',
  description: 'Mid/side stereo widener (0 = mono, 1 = normal, 2 = extra wide)',
  params: [P('width', 'Width', 0, 2, 1.3), P('bassmono', 'Bass Mono', 0, 1, 0, { step: 1, options: [ { label: 'Off', value: 0 }, { label: 'On', value: 1 } ] })],
  create(ctx) {
    const input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    // M = (L+R)/2, S = (L-R)/2 ; L' = M + wS, R' = M - wS
    const lToM = ctx.createGain(), rToM = ctx.createGain(), lToS = ctx.createGain(), rToS = ctx.createGain();
    lToM.gain.value = 0.5; rToM.gain.value = 0.5; lToS.gain.value = 0.5; rToS.gain.value = -0.5;
    const mid = ctx.createGain(), side = ctx.createGain();
    const sideHp = ctx.createBiquadFilter();
    sideHp.type = 'highpass';
    sideHp.frequency.value = 10;
    const sideW = ctx.createGain();
    const sideInv = ctx.createGain();
    sideInv.gain.value = -1;
    input.connect(split);
    split.connect(lToM, 0); split.connect(rToM, 1); split.connect(lToS, 0); split.connect(rToS, 1);
    lToM.connect(mid); rToM.connect(mid); lToS.connect(side); rToS.connect(side);
    side.connect(sideHp).connect(sideW);
    mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
    sideW.connect(merge, 0, 0);
    sideW.connect(sideInv).connect(merge, 0, 1);
    const d = WIDTH.params;
    return {
      input,
      output: merge,
      nodes: [input, split, merge, lToM, rToM, lToS, rToS, mid, side, sideHp, sideW, sideInv],
      set(p) {
        setParam(sideW.gain, val(p, d, 'width'), ctx);
        setParam(sideHp.frequency, val(p, d, 'bassmono') > 0.5 ? 180 : 10, ctx);
      },
    };
  },
};

const FILTER: EffectDef = {
  id: 'filter',
  name: 'Auto Filter',
  description: 'Resonant filter with tempo-synced LFO',
  params: [
    P('type', 'Type', 0, 2, 0, { step: 1, options: [ { label: 'Low', value: 0 }, { label: 'High', value: 1 }, { label: 'Band', value: 2 } ] }),
    P('freq', 'Freq', 40, 18000, 2000, { unit: 'Hz', curve: 'log' }),
    P('q', 'Reso', 0.3, 20, 1, { curve: 'log' }),
    P('lfo', 'LFO Rate', 0, 16, 0, { step: 1, unit: '/bar', hint: 'LFO cycles per bar (0 = off)' }),
    P('depth', 'LFO Depth', 0, 1, 0.5),
  ],
  create(ctx) {
    const f = ctx.createBiquadFilter();
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.connect(lg).connect(f.detune);
    lfo.start();
    const d = FILTER.params;
    return {
      input: f,
      output: f,
      nodes: [f, lfo, lg],
      stop: () => lfo.stop(),
      set(p, info) {
        f.type = (['lowpass', 'highpass', 'bandpass'] as BiquadFilterType[])[Math.round(val(p, d, 'type'))] ?? 'lowpass';
        setParam(f.frequency, val(p, d, 'freq'), ctx);
        setParam(f.Q, val(p, d, 'q'), ctx);
        const rate = val(p, d, 'lfo');
        setParam(lfo.frequency, (rate * info.bpm) / 60 / 4, ctx);
        setParam(lg.gain, rate > 0 ? val(p, d, 'depth') * 2400 : 0, ctx);
      },
    };
  },
};

const DRIVE: EffectDef = {
  id: 'drive',
  name: 'Drive',
  description: 'Warm tube-style saturation with tone control',
  params: [P('drive', 'Drive', 0, 1, 0.3), P('tone', 'Tone', 0, 1, 0.6), P('output', 'Output', -18, 6, -3, { unit: 'dB' })],
  create(ctx) {
    const pre = ctx.createGain();
    const sh = ctx.createWaveShaper();
    sh.oversample = '4x';
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    const out = ctx.createGain();
    pre.connect(sh).connect(tone).connect(out);
    let lastDrive = -1;
    const d = DRIVE.params;
    return {
      input: pre,
      output: out,
      nodes: [pre, sh, tone, out],
      set(p) {
        const dr = val(p, d, 'drive');
        if (dr !== lastDrive) {
          const k = 1 + dr * 30;
          sh.curve = makeCurve((x) => Math.tanh(k * x) / Math.tanh(k));
          lastDrive = dr;
        }
        setParam(tone.frequency, 800 * Math.pow(22, val(p, d, 'tone')), ctx);
        setParam(out.gain, Math.pow(10, val(p, d, 'output') / 20), ctx);
      },
    };
  },
};

const LOFI: EffectDef = {
  id: 'lofi',
  name: 'Lo-Fi',
  description: 'Bit reduction, tape wobble and dusty tone',
  params: [P('bits', 'Bits', 2, 16, 12, { step: 1 }), P('tone', 'Tone', 0, 1, 0.5), P('wobble', 'Wobble', 0, 1, 0.3)],
  create(ctx) {
    const input = ctx.createGain();
    const del = ctx.createDelay(0.05);
    del.delayTime.value = 0.01;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.7;
    const lg = ctx.createGain();
    lfo.connect(lg).connect(del.delayTime);
    lfo.start();
    const sh = ctx.createWaveShaper();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    input.connect(del).connect(sh).connect(lp).connect(hp);
    let lastBits = -1;
    const d = LOFI.params;
    return {
      input,
      output: hp,
      nodes: [input, del, lfo, lg, sh, lp, hp],
      stop: () => lfo.stop(),
      set(p) {
        const bits = Math.round(val(p, d, 'bits'));
        if (bits !== lastBits) {
          const steps = Math.pow(2, bits - 1);
          sh.curve = makeCurve((x) => Math.round(x * steps) / steps, 4096);
          lastBits = bits;
        }
        setParam(lp.frequency, 1500 * Math.pow(10, val(p, d, 'tone')), ctx);
        setParam(lg.gain, val(p, d, 'wobble') * 0.0025, ctx);
      },
    };
  },
};

const PINGPONG: EffectDef = {
  id: 'pingpong',
  name: 'Ping-Pong Delay',
  description: 'Tempo-synced stereo ping-pong delay',
  params: [
    P('steps', 'Time', 1, 16, 3, { step: 1, unit: '/16' }),
    P('feedback', 'Feedback', 0, 0.95, 0.45),
    P('tone', 'Tone', 0, 1, 0.6),
  ],
  create(ctx) {
    const input = ctx.createGain();
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    const dl = ctx.createDelay(4);
    const dr = ctx.createDelay(4);
    const fb = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const merge = ctx.createChannelMerger(2);
    input.connect(mono).connect(dl);
    dl.connect(lp).connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merge, 0, 0);
    dr.connect(merge, 0, 1);
    const d = PINGPONG.params;
    return {
      input,
      output: merge,
      nodes: [input, mono, dl, dr, fb, lp, merge],
      set(p, info) {
        const t = (val(p, d, 'steps') * 60) / info.bpm / 4;
        setParam(dl.delayTime, t, ctx);
        setParam(dr.delayTime, t, ctx);
        setParam(fb.gain, val(p, d, 'feedback'), ctx);
        setParam(lp.frequency, 1000 * Math.pow(15, val(p, d, 'tone')), ctx);
      },
    };
  },
};

const SPACE: EffectDef = {
  id: 'space',
  name: 'Space Reverb',
  description: 'Convolution reverb with generated room impulse',
  params: [P('size', 'Size', 0.2, 8, 2.5, { unit: 's', curve: 'log' }), P('damp', 'Damping', 0, 1, 0.5), P('predelay', 'Pre-delay', 0, 0.2, 0.02, { unit: 's' })],
  create(ctx) {
    const input = ctx.createGain();
    const pre = ctx.createDelay(1);
    const conv = ctx.createConvolver();
    input.connect(pre).connect(conv);
    let key = '';
    const d = SPACE.params;
    return {
      input,
      output: conv,
      nodes: [input, pre, conv],
      set(p) {
        const size = val(p, d, 'size');
        const damp = val(p, d, 'damp');
        const k = `${size.toFixed(2)}|${damp.toFixed(2)}`;
        if (k !== key) {
          conv.buffer = impulse(ctx, size, 2.5, damp);
          key = k;
        }
        setParam(pre.delayTime, val(p, d, 'predelay'), ctx);
      },
    };
  },
};

export const EFFECTS: EffectDef[] = [EQ3, COMPRESSOR, LIMITER, CHORUS, WIDTH, FILTER, DRIVE, LOFI, PINGPONG, SPACE];
export const EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

/** creates an effect wrapped with dry/wet + bypass */
export function createEffect(ctx: BaseAudioContext, id: string): EffectInstance | null {
  const def = EFFECT_MAP[id];
  if (!def) return null;
  const core = def.create(ctx);
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(core.input);
  core.output.connect(wet).connect(output);
  // "insert" style effects replace the signal at mix = 1, send style ones (reverb/delay/chorus) blend
  return {
    input,
    output,
    meter: core.meter,
    update(params, mix, enabled, info) {
      core.set(params, info);
      const m = enabled ? mix : 0;
      const isSend = id === 'space' || id === 'pingpong';
      setParam(dry.gain, isSend ? 1 : 1 - m, ctx);
      setParam(wet.gain, m, ctx);
    },
    dispose() {
      try {
        core.stop?.();
      } catch {
        /* already stopped */
      }
      [input, output, dry, wet, ...core.nodes].forEach((n) => {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      });
    },
  };
}
