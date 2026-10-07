// Strudel Studio plugin SDK ("VSTs for Strudel").
//
// A plugin instrument is plain JavaScript that calls `definePlugin({...})`.
// Under the hood it uses only public Strudel APIs:
//   registerSound(name, onTrigger)  – superdough sound registry (same as built-in synths)
//   registerControl(name)           – adds a pattern method, e.g. .triosc_w1(2)
//   getAudioContext()               – the active (realtime or offline) AudioContext
// Because of that, the exact same source runs inside Strudel Studio AND on https://strudel.cc
// (the code exporter embeds the SDK + plugin sources into the exported code).

export const PLUGIN_SDK_SOURCE = String.raw`const definePlugin = globalThis.definePlugin ?? (globalThis.definePlugin = (() => {
  const noiseCache = new WeakMap();
  const workletCache = new Map();
  const CHROMA = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const toMidi = (v) => {
    if (typeof v.freq === 'number') return 69 + 12 * Math.log2(v.freq / 440);
    const n = v.note ?? 60;
    if (typeof n === 'number') return n;
    const m = /^([a-gA-G])([#bsf]*)(-?\d*)$/.exec(String(n));
    if (!m) return 60;
    const acc = [...m[2]].reduce((a, c) => a + (c === '#' || c === 's' ? 1 : -1), 0);
    return (Number(m[3] === '' ? 3 : m[3]) + 1) * 12 + CHROMA[m[1].toLowerCase()] + acc;
  };
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // linear ADSR on an AudioParam, returns the time the release ends
  const adsr = (param, t, dur, a, d, s, r, peak = 1) => {
    a = Math.max(0.001, a); d = Math.max(0.001, d); r = Math.max(0.005, r);
    const hold = t + Math.max(0.005, dur);
    param.cancelScheduledValues(t);
    param.setValueAtTime(0, t);
    let lvl;
    if (dur <= a) { lvl = (peak * dur) / a; param.linearRampToValueAtTime(lvl, hold); }
    else {
      param.linearRampToValueAtTime(peak, t + a);
      if (dur <= a + d) { lvl = peak + (s * peak - peak) * ((dur - a) / d); param.linearRampToValueAtTime(lvl, hold); }
      else { lvl = s * peak; param.linearRampToValueAtTime(lvl, t + a + d); param.setValueAtTime(lvl, hold); }
    }
    param.linearRampToValueAtTime(0, hold + r);
    return hold + r;
  };
  const noise = (ac) => {
    let b = noiseCache.get(ac);
    if (!b) {
      b = ac.createBuffer(2, ac.sampleRate * 2, ac.sampleRate);
      for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
      noiseCache.set(ac, b);
    }
    return b;
  };
  const loadWorklet = (ac, code) => {
    let perCtx = workletCache.get(code);
    if (!perCtx) workletCache.set(code, (perCtx = new WeakMap()));
    let p = perCtx.get(ac);
    if (!p) {
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      p = ac.audioWorklet.addModule(url);
      perCtx.set(ac, p);
    }
    return p;
  };
  return (def) => {
    const prefix = def.id + '_';
    const params = def.params || {};
    Object.keys(params).forEach((k) => registerControl(prefix + k));
    const env = Object.assign({ a: 0.005, d: 0.1, s: 0.8, r: 0.1 }, def.envelope || {});
    registerSound(def.id, async (t, value, onended) => {
      const ac = getAudioContext();
      const p = {};
      for (const k in params) p[k] = value[prefix + k] ?? params[k].def;
      const midi = toMidi(value);
      if (def.worklet) await loadWorklet(ac, def.worklet);
      const api = {
        ac, t, dur: value.duration ?? 0.25, midi, freq: mtof(midi), p, value,
        a: value.attack ?? env.a, d: value.decay ?? env.d, s: value.sustain ?? env.s, r: value.release ?? env.r,
        adsr, mtof, noise: () => noise(ac),
      };
      const h = def.voice(api);
      const sources = h.sources || [];
      const end = h.end ?? t + api.dur + api.r;
      sources.forEach((s) => { try { s.stop(end); } catch (e) {} });
      const anchor = ac.createConstantSource();
      anchor.offset.value = 0;
      anchor.start(t);
      anchor.stop(end + 0.05);
      anchor.onended = () => { try { h.node.disconnect(); } catch (e) {} onended(); };
      return { node: h.node, stop: (tt) => sources.concat([anchor]).forEach((s) => { try { s.stop(tt); } catch (e) {} }) };
    }, { type: 'synth', plugin: def.id, prebake: true });
    if (def.worklet) { try { loadWorklet(getAudioContext(), def.worklet); } catch (e) {} }
    if (globalThis.__studioPluginHook) globalThis.__studioPluginHook(def);
    return def;
  };
})());`;

export const PLUGIN_TEMPLATE = String.raw`// My Plugin — a custom instrument for Strudel Studio (and strudel.cc)
// voice() is called for every note. Build WebAudio nodes, return the output node.
definePlugin({
  id: 'mysynth',            // sound name, used as .s("mysynth")
  name: 'My Synth',
  description: 'Two detuned oscillators with a filter sweep',
  params: {
    // each param becomes a pattern method: .mysynth_detune(12)
    detune: { label: 'Detune', min: 0, max: 50, def: 12, unit: 'ct' },
    wave:   { label: 'Wave', min: 0, max: 3, def: 2, step: 1, options: ['sine', 'triangle', 'sawtooth', 'square'] },
    sweep:  { label: 'Sweep', min: 0, max: 1, def: 0.6 },
  },
  envelope: { a: 0.01, d: 0.3, s: 0.6, r: 0.3 },
  voice({ ac, t, dur, freq, p, a, d, s, r, adsr }) {
    const out = ac.createGain();
    const env = ac.createGain();
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(freq * (1 + 16 * p.sweep), t);
    filter.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.05 + d);
    const types = ['sine', 'triangle', 'sawtooth', 'square'];
    const oscs = [-1, 1].map((sign) => {
      const o = ac.createOscillator();
      o.type = types[p.wave] || 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = sign * p.detune;
      o.connect(filter);
      o.start(t);
      return o;
    });
    out.gain.value = 0.3;
    filter.connect(env).connect(out);
    const end = adsr(env.gain, t, dur, a, d, s, r);
    return { node: out, sources: oscs, end };
  },
});
`;

export interface PluginParamSpec {
  label: string;
  min: number;
  max: number;
  def: number;
  step?: number;
  unit?: string;
  curve?: 'lin' | 'log' | 'exp';
  options?: string[];
  automatable?: boolean;
}

export interface PluginDefinition {
  id: string;
  name: string;
  description?: string;
  category?: string;
  params?: Record<string, PluginParamSpec>;
  envelope?: { a?: number; d?: number; s?: number; r?: number };
  worklet?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  voice: (api: any) => any;
}

/** JS single-quoted string literal (double quotes / backticks are mini-notation in Strudel code) */
export function singleQuoted(str: string): string {
  return "'" + str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}
