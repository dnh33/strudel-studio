import { singleQuoted } from './sdk';
// Stock plugin instruments. Each is plain JS source written against the plugin SDK (see sdk.ts),
// so it can be embedded 1:1 in code exported to strudel.cc.

export interface StockPlugin {
  id: string;
  name: string;
  category: string;
  source: string;
}

const TRIOSC = String.raw`definePlugin({
  id: 'triosc',
  name: '3xOsc',
  description: 'Three oscillators with coarse/fine tuning and level, like the classic tracker synth',
  category: 'Synth',
  params: {
    w1: { label: 'Osc1 Wave', min: 0, max: 3, def: 2, step: 1, options: ['Sine', 'Tri', 'Saw', 'Square'] },
    c1: { label: 'Osc1 Coarse', min: -24, max: 24, def: 0, step: 1, unit: 'st' },
    f1: { label: 'Osc1 Fine', min: -50, max: 50, def: 0, unit: 'ct' },
    l1: { label: 'Osc1 Level', min: 0, max: 1, def: 0.8, automatable: true },
    w2: { label: 'Osc2 Wave', min: 0, max: 3, def: 3, step: 1, options: ['Sine', 'Tri', 'Saw', 'Square'] },
    c2: { label: 'Osc2 Coarse', min: -24, max: 24, def: -12, step: 1, unit: 'st' },
    f2: { label: 'Osc2 Fine', min: -50, max: 50, def: 6, unit: 'ct' },
    l2: { label: 'Osc2 Level', min: 0, max: 1, def: 0.5, automatable: true },
    w3: { label: 'Osc3 Wave', min: 0, max: 3, def: 2, step: 1, options: ['Sine', 'Tri', 'Saw', 'Square'] },
    c3: { label: 'Osc3 Coarse', min: -24, max: 24, def: 0, step: 1, unit: 'st' },
    f3: { label: 'Osc3 Fine', min: -50, max: 50, def: -7, unit: 'ct' },
    l3: { label: 'Osc3 Level', min: 0, max: 1, def: 0.4, automatable: true },
    width: { label: 'Stereo', min: 0, max: 1, def: 0.5 },
    sub: { label: 'Sub', min: 0, max: 1, def: 0 },
  },
  envelope: { a: 0.005, d: 0.2, s: 0.7, r: 0.15 },
  voice({ ac, t, dur, freq, p, a, d, s, r, adsr }) {
    const types = ['sine', 'triangle', 'sawtooth', 'square'];
    const env = ac.createGain();
    const mix = ac.createGain();
    mix.gain.value = 0.22;
    const sources = [];
    [[p.w1, p.c1, p.f1, p.l1, -1], [p.w2, p.c2, p.f2, p.l2, 1], [p.w3, p.c3, p.f3, p.l3, 0]].forEach(([w, c, f, l, side]) => {
      if (l <= 0) return;
      const o = ac.createOscillator();
      o.type = types[Math.round(w)] || 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = c * 100 + f;
      const g = ac.createGain();
      g.gain.value = l;
      const pan = ac.createStereoPanner();
      pan.pan.value = side * p.width * 0.8;
      o.connect(g).connect(pan).connect(mix);
      o.start(t);
      sources.push(o);
    });
    if (p.sub > 0) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq / 2;
      const g = ac.createGain();
      g.gain.value = p.sub * 1.5;
      o.connect(g).connect(mix);
      o.start(t);
      sources.push(o);
    }
    mix.connect(env);
    const end = adsr(env.gain, t, dur, a, d, s, r);
    return { node: env, sources, end };
  },
});`;

const FMKEYS = String.raw`definePlugin({
  id: 'fmkeys',
  name: 'FM Keys',
  description: 'Two-operator FM synth for e-pianos, bells, plucks and metallic basses',
  category: 'Synth',
  params: {
    ratio: { label: 'Ratio', min: 0.5, max: 8, def: 1, step: 0.5 },
    index: { label: 'Index', min: 0, max: 12, def: 2.5, automatable: true },
    idecay: { label: 'Idx Decay', min: 0.01, max: 4, def: 0.6, unit: 's', curve: 'exp' },
    bell: { label: 'Bell', min: 0, max: 1, def: 0.15 },
    tine: { label: 'Tine', min: 0, max: 1, def: 0.3 },
    detune: { label: 'Chorus', min: 0, max: 20, def: 5, unit: 'ct' },
  },
  envelope: { a: 0.002, d: 1.4, s: 0.25, r: 0.5 },
  voice({ ac, t, dur, freq, p, a, d, s, r, adsr }) {
    const out = ac.createGain();
    out.gain.value = 0.35;
    const env = ac.createGain();
    const sources = [];
    const holdEnd = t + Math.max(dur, 0.01);
    [-1, 1].forEach((sign) => {
      const car = ac.createOscillator();
      car.frequency.value = freq;
      car.detune.value = sign * p.detune;
      const mod = ac.createOscillator();
      mod.frequency.value = freq * p.ratio;
      const mg = ac.createGain();
      const depth = freq * p.index;
      mg.gain.setValueAtTime(depth, t);
      mg.gain.setTargetAtTime(depth * 0.12, t, p.idecay / 3);
      mod.connect(mg).connect(car.frequency);
      // inharmonic bell partial
      const bell = ac.createOscillator();
      bell.frequency.value = freq * 3.5;
      const bg = ac.createGain();
      bg.gain.setValueAtTime(freq * p.bell * 6, t);
      bg.gain.setTargetAtTime(0, t, 0.15);
      bell.connect(bg).connect(car.frequency);
      const pan = ac.createStereoPanner();
      pan.pan.value = sign * 0.3;
      car.connect(pan).connect(env);
      [car, mod, bell].forEach((o) => { o.start(t); sources.push(o); });
    });
    // tine transient
    if (p.tine > 0) {
      const tn = ac.createOscillator();
      tn.frequency.value = freq * 7;
      const tg = ac.createGain();
      tg.gain.setValueAtTime(p.tine * 0.4, t);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      tn.connect(tg).connect(env);
      tn.start(t);
      sources.push(tn);
    }
    env.connect(out);
    const end = adsr(env.gain, t, dur, a, d, s, r);
    return { node: out, sources, end: Math.max(end, holdEnd) };
  },
});`;

const DRUMSYNTH = String.raw`definePlugin({
  id: 'drumsynth',
  name: 'DrumSynth',
  description: 'Analog-style synthesized drums: kick, snare, hat, open hat, clap, tom, cowbell',
  category: 'Drums',
  params: {
    kind: { label: 'Drum', min: 0, max: 6, def: 0, step: 1, options: ['Kick', 'Snare', 'Hat', 'Open Hat', 'Clap', 'Tom', 'Cowbell'] },
    tune: { label: 'Tune', min: -12, max: 12, def: 0, unit: 'st' },
    decay: { label: 'Decay', min: 0.1, max: 3, def: 1, unit: 'x', curve: 'exp', automatable: true },
    tone: { label: 'Tone', min: 0, max: 1, def: 0.5, automatable: true },
    punch: { label: 'Punch', min: 0, max: 1, def: 0.5 },
  },
  envelope: { a: 0.001, d: 0.1, s: 1, r: 0.05 },
  voice({ ac, t, midi, p, noise }) {
    const k = Math.round(p.kind);
    const tune = Math.pow(2, (p.tune + (midi - 60)) / 12);
    const dec = p.decay;
    const out = ac.createGain();
    const sources = [];
    let end = t + 0.5;
    const osc = (type, f) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); sources.push(o); return o; };
    const nz = () => { const n = ac.createBufferSource(); n.buffer = noise(); n.loop = true; n.start(t, Math.random()); sources.push(n); return n; };
    const env = (g, peak, len, attack = 0.001) => {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + len);
      end = Math.max(end, t + attack + len + 0.02);
    };
    const filt = (type, f, q = 1) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    if (k === 0) { // kick
      const o = osc('sine', 50 * tune);
      o.frequency.setValueAtTime(50 * tune * (3 + p.punch * 4), t);
      o.frequency.exponentialRampToValueAtTime(50 * tune, t + 0.03 + 0.08 * (1 - p.tone));
      const g = ac.createGain(); env(g, 1, 0.45 * dec);
      const sh = ac.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * (1 + p.punch * 3)); }
      sh.curve = curve;
      o.connect(g).connect(sh).connect(out);
      const n = nz(); const hp = filt('highpass', 3000); const ng = ac.createGain(); env(ng, 0.25 * p.punch, 0.012);
      n.connect(hp).connect(ng).connect(out);
    } else if (k === 1) { // snare
      const o = osc('triangle', 185 * tune);
      o.frequency.setValueAtTime(260 * tune, t);
      o.frequency.exponentialRampToValueAtTime(185 * tune, t + 0.04);
      const g = ac.createGain(); env(g, 0.7 * (1 - p.tone * 0.6), 0.12 * dec);
      o.connect(g).connect(out);
      const n = nz(); const bp = filt('highpass', 1200 + p.tone * 2000); const ng = ac.createGain(); env(ng, 0.6, 0.2 * dec);
      n.connect(bp).connect(ng).connect(out);
    } else if (k === 2 || k === 3) { // hats
      const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
      const mix = ac.createGain(); mix.gain.value = 0.18;
      ratios.forEach((rr) => osc('square', 40 * rr * tune * (1 + p.tone)).connect(mix));
      const bp = filt('bandpass', 10000, 0.8); const hp = filt('highpass', 7000);
      const g = ac.createGain(); env(g, 0.9, (k === 2 ? 0.05 : 0.4) * dec);
      mix.connect(bp).connect(hp).connect(g).connect(out);
    } else if (k === 4) { // clap
      const n = nz(); const bp = filt('bandpass', 1100 + p.tone * 800, 1.5);
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      [0, 0.011, 0.022].forEach((o) => { g.gain.setValueAtTime(0.9, t + o); g.gain.exponentialRampToValueAtTime(0.1, t + o + 0.01); });
      g.gain.setValueAtTime(0.7, t + 0.033);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.033 + 0.25 * dec);
      end = t + 0.3 + 0.25 * dec;
      n.connect(bp).connect(g).connect(out);
    } else if (k === 5) { // tom
      const o = osc('sine', 120 * tune);
      o.frequency.setValueAtTime(120 * tune * 1.6, t);
      o.frequency.exponentialRampToValueAtTime(120 * tune, t + 0.1);
      const g = ac.createGain(); env(g, 0.9, 0.35 * dec);
      o.connect(g).connect(out);
    } else { // cowbell
      const mix = ac.createGain(); mix.gain.value = 0.3;
      osc('square', 540 * tune).connect(mix); osc('square', 800 * tune).connect(mix);
      const bp = filt('bandpass', 1000 + p.tone * 1500, 2);
      const g = ac.createGain(); env(g, 0.8, 0.3 * dec, 0.002);
      mix.connect(bp).connect(g).connect(out);
    }
    return { node: out, sources, end };
  },
});`;

const PLUCK_WORKLET = String.raw`class StudioPluck extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions;
    this.start = p.start; this.end = p.end;
    this.bright = p.bright;
    this.D = Math.max(2, sampleRate / p.freq - (1 - this.bright));
    this.g = Math.pow(0.001, 1 / (Math.max(0.05, p.decay) * p.freq));
    this.size = 1 << 13;
    this.buf = new Float32Array(this.size);
    this.w = 0; this.n = 0;
    this.burst = Math.ceil(this.D);
    this.lp = 0; this.pick = p.pick;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const t0 = currentTime;
    const startFrame = Math.round((this.start - t0) * sampleRate);
    for (let i = 0; i < L.length; i++) {
      if (i < startFrame) { L[i] = 0; continue; }
      let x = 0;
      if (this.n < this.burst) {
        const r = Math.random() * 2 - 1;
        this.lp += (r - this.lp) * (0.2 + 0.8 * this.pick);
        x = this.lp;
      }
      const rp = this.w - this.D;
      const i0 = Math.floor(rp);
      const frac = rp - i0;
      const a = this.buf[(i0 + this.size) & (this.size - 1)];
      const b = this.buf[(i0 + 1 + this.size) & (this.size - 1)];
      const c = this.buf[(i0 - 1 + this.size) & (this.size - 1)];
      const d0 = a + (b - a) * frac;
      const d1 = c + (a - c) * frac;
      const y = x + this.g * (this.bright * d0 + (1 - this.bright) * d1);
      this.buf[this.w & (this.size - 1)] = y;
      this.w++; this.n++;
      L[i] = y * 0.5;
    }
    for (let c = 1; c < out.length; c++) out[c].set(L);
    return t0 < this.end;
  }
}
registerProcessor('studio-pluck', StudioPluck);`;

const PLUCK = `definePlugin({
  id: 'pluck',
  name: 'Pluck (Karplus-Strong)',
  description: 'Physically modelled plucked string (AudioWorklet)',
  category: 'Physical',
  worklet: ${singleQuoted(PLUCK_WORKLET)},
  params: {
    decay: { label: 'Decay', min: 0.1, max: 8, def: 2, unit: 's', curve: 'exp', automatable: true },
    bright: { label: 'Bright', min: 0.5, max: 1, def: 0.75, automatable: true },
    pick: { label: 'Pick', min: 0, max: 1, def: 0.6 },
    body: { label: 'Body', min: 0, max: 1, def: 0.3 },
  },
  envelope: { a: 0.001, d: 0.1, s: 1, r: 0.3 },
  voice({ ac, t, dur, freq, p, r }) {
    const end = t + Math.min(dur + r + p.decay, 12);
    const node = new AudioWorkletNode(ac, 'studio-pluck', {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { start: t, end, freq, decay: p.decay, bright: p.bright, pick: p.pick },
    });
    const body = ac.createBiquadFilter();
    body.type = 'peaking'; body.frequency.value = 220; body.Q.value = 1; body.gain.value = p.body * 9;
    const g = ac.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.setValueAtTime(1, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + r);
    node.connect(body).connect(g);
    return { node: g, sources: [], end: t + dur + r + 0.05 };
  },
});`;

const SUPERPAD = String.raw`definePlugin({
  id: 'superpad',
  name: 'SuperPad',
  description: 'Lush additive pad: detuned unison voices, adjustable brightness and stereo width',
  category: 'Synth',
  params: {
    voices: { label: 'Voices', min: 1, max: 7, def: 5, step: 1 },
    detune: { label: 'Detune', min: 0, max: 50, def: 14, unit: 'ct' },
    bright: { label: 'Bright', min: 0, max: 1, def: 0.45, automatable: true },
    width: { label: 'Width', min: 0, max: 1, def: 0.85 },
    sub: { label: 'Sub', min: 0, max: 1, def: 0.25 },
    air: { label: 'Air', min: 0, max: 1, def: 0.2 },
  },
  envelope: { a: 0.35, d: 0.6, s: 0.8, r: 1.2 },
  voice({ ac, t, dur, freq, p, a, d, s, r, adsr, noise }) {
    const n = 24;
    const real = new Float32Array(n), imag = new Float32Array(n);
    const roll = 2.2 - p.bright * 1.6;
    for (let h = 1; h < n; h++) imag[h] = 1 / Math.pow(h, roll);
    const wave = ac.createPeriodicWave(real, imag);
    const mix = ac.createGain();
    const V = Math.round(p.voices);
    mix.gain.value = 0.28 / Math.sqrt(V);
    const sources = [];
    for (let i = 0; i < V; i++) {
      const x = V === 1 ? 0 : (i / (V - 1)) * 2 - 1;
      const o = ac.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = freq;
      o.detune.value = x * p.detune + (Math.random() - 0.5) * 2;
      const pan = ac.createStereoPanner();
      pan.pan.value = x * p.width;
      o.connect(pan).connect(mix);
      o.start(t, Math.random() * 0.01);
      sources.push(o);
    }
    if (p.sub > 0) {
      const o = ac.createOscillator();
      o.frequency.value = freq / 2;
      const g = ac.createGain(); g.gain.value = p.sub * 0.35;
      o.connect(g).connect(mix); o.start(t); sources.push(o);
    }
    if (p.air > 0) {
      const nz = ac.createBufferSource(); nz.buffer = noise(); nz.loop = true;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(12000, freq * 8); bp.Q.value = 3;
      const g = ac.createGain(); g.gain.value = p.air * 0.25;
      nz.connect(bp).connect(g).connect(mix); nz.start(t); sources.push(nz);
    }
    const env = ac.createGain();
    mix.connect(env);
    const end = adsr(env.gain, t, dur, a, d, s, r);
    return { node: env, sources, end };
  },
});`;

const SUB808 = String.raw`definePlugin({
  id: 'sub808',
  name: 'Sub 808',
  description: 'Booming 808 bass with pitch glide, saturation and click',
  category: 'Bass',
  params: {
    glide: { label: 'Glide', min: 0, max: 24, def: 7, unit: 'st' },
    gtime: { label: 'Glide T', min: 0.005, max: 0.5, def: 0.06, unit: 's', curve: 'exp' },
    drive: { label: 'Drive', min: 0, max: 1, def: 0.35, automatable: true },
    click: { label: 'Click', min: 0, max: 1, def: 0.4 },
    boom: { label: 'Boom', min: 0.1, max: 4, def: 1.2, unit: 's', curve: 'exp' },
  },
  envelope: { a: 0.002, d: 0.1, s: 1, r: 0.2 },
  voice({ ac, t, dur, freq, p, r }) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * Math.pow(2, p.glide / 12), t);
    o.frequency.exponentialRampToValueAtTime(freq, t + p.gtime);
    const sh = ac.createWaveShaper();
    const k = 1 + p.drive * 8;
    const curve = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) { const x = i / 1024 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    sh.curve = curve;
    const g = ac.createGain();
    const tau = p.boom / 3;
    const hold = Math.max(0.01, dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.003, tau);
    // value of the exponential decay at note-off, then release linearly
    const lvl = 0.9 * Math.exp(-Math.max(0, hold - 0.003) / tau);
    g.gain.setValueAtTime(lvl, t + hold);
    const end = t + hold + Math.max(0.01, r);
    g.gain.linearRampToValueAtTime(0, end);
    o.connect(sh).connect(g);
    const sources = [o];
    if (p.click > 0) {
      const c = ac.createOscillator(); c.type = 'square'; c.frequency.value = 1400;
      const cg = ac.createGain(); cg.gain.setValueAtTime(p.click * 0.3, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.01);
      c.connect(cg).connect(g); c.start(t); sources.push(c);
    }
    o.start(t);
    return { node: g, sources, end };
  },
});`;

const CHIPBOY = String.raw`definePlugin({
  id: 'chipboy',
  name: 'ChipBoy',
  description: '8-bit console voice: pulse widths, arpeggio and pitch sweep',
  category: 'Synth',
  params: {
    duty: { label: 'Duty', min: 0, max: 2, def: 1, step: 1, options: ['12.5%', '25%', '50%'] },
    arp: { label: 'Arp', min: 0, max: 3, def: 0, step: 1, options: ['Off', 'Major', 'Minor', 'Octave'] },
    speed: { label: 'Arp Spd', min: 10, max: 60, def: 30, unit: 'Hz' },
    sweep: { label: 'Sweep', min: -24, max: 24, def: 0, unit: 'st' },
    bits: { label: 'Crunch', min: 0, max: 1, def: 0.3 },
  },
  envelope: { a: 0.001, d: 0.15, s: 0.6, r: 0.05 },
  voice({ ac, t, dur, freq, p, a, d, s, r, adsr }) {
    const duty = [0.125, 0.25, 0.5][Math.round(p.duty)] || 0.5;
    const n = 32, real = new Float32Array(n), imag = new Float32Array(n);
    for (let h = 1; h < n; h++) { real[h] = (2 / (h * Math.PI)) * Math.sin(h * Math.PI * duty); }
    const o = ac.createOscillator();
    o.setPeriodicWave(ac.createPeriodicWave(real, imag));
    o.frequency.setValueAtTime(freq, t);
    if (p.sweep) o.frequency.exponentialRampToValueAtTime(freq * Math.pow(2, p.sweep / 12), t + Math.max(dur, 0.05));
    const arps = [[0], [0, 4, 7], [0, 3, 7], [0, 12]][Math.round(p.arp)] || [0];
    if (arps.length > 1) {
      const step = 1 / p.speed;
      let i = 0;
      for (let tt = t; tt < t + dur + r; tt += step) o.detune.setValueAtTime(arps[i++ % arps.length] * 100, tt);
    }
    const levels = Math.round(4 + (1 - p.bits) * 28);
    const sh = ac.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.round(x * levels) / levels; }
    sh.curve = curve;
    const env = ac.createGain();
    const g = ac.createGain(); g.gain.value = 0.3;
    o.connect(sh).connect(g).connect(env);
    o.start(t);
    const end = adsr(env.gain, t, dur, a, d, s, r);
    return { node: env, sources: [o], end };
  },
});`;

export const STOCK_PLUGINS: StockPlugin[] = [
  { id: 'triosc', name: '3xOsc', category: 'Synth', source: TRIOSC },
  { id: 'superpad', name: 'SuperPad', category: 'Synth', source: SUPERPAD },
  { id: 'fmkeys', name: 'FM Keys', category: 'Synth', source: FMKEYS },
  { id: 'chipboy', name: 'ChipBoy', category: 'Synth', source: CHIPBOY },
  { id: 'sub808', name: 'Sub 808', category: 'Bass', source: SUB808 },
  { id: 'pluck', name: 'Pluck', category: 'Physical', source: PLUCK },
  { id: 'drumsynth', name: 'DrumSynth', category: 'Drums', source: DRUMSYNTH },
];
