import { useRef } from 'react';
import { engine } from '../../engine/engine';
import { useTick } from '../ticker';

const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-6));
const dbToY = (db: number) => Math.max(0, Math.min(1, (db + 60) / 66)); // -60..+6 dB

/** stereo peak meter for a mixer insert (0 = master) */
export function Meter({ insert, height = 140, width = 14 }: { insert: number; height?: number; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hold = useRef({ l: 0, r: 0, lh: 0, rh: 0, t: 0 });
  useTick(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d');
    if (!g) return;
    const m = engine.meter(insert);
    const h = hold.current;
    const decay = 0.9;
    const l = m ? dbToY(toDb(m.l.peak)) : 0;
    const r = m ? dbToY(toDb(m.r.peak)) : 0;
    h.l = Math.max(l, h.l * decay);
    h.r = Math.max(r, h.r * decay);
    h.lh = Math.max(h.l, h.lh - 0.004);
    h.rh = Math.max(h.r, h.rh - 0.004);
    const W = c.width;
    const H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#101316';
    g.fillRect(0, 0, W, H);
    const bw = (W - 3) / 2;
    const draw = (x: number, v: number, pk: number) => {
      const y = H - v * H;
      const grd = g.createLinearGradient(0, H, 0, 0);
      grd.addColorStop(0, '#3ddc84');
      grd.addColorStop(0.72, '#c6e04a');
      grd.addColorStop(0.88, '#ffb33d');
      grd.addColorStop(0.92, '#ff4d4d');
      g.fillStyle = grd;
      g.fillRect(x, y, bw, H - y);
      g.fillStyle = pk > 0.905 ? '#ff4d4d' : '#e8ecef';
      g.fillRect(x, H - pk * H, bw, 1.5);
    };
    draw(1, h.l, h.lh);
    draw(2 + bw, h.r, h.rh);
    // 0 dB line
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, H - dbToY(0) * H, W, 1);
  });
  return <canvas ref={ref} className="meter" width={width} height={height} style={{ width, height }} />;
}

/** master oscilloscope / spectrum for the toolbar */
export function Scope({ width = 150, height = 36 }: { width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const buf = useRef<Float32Array<ArrayBuffer> | null>(null);
  const fbuf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  useTick(() => {
    const c = ref.current;
    const an = engine.scope();
    if (!c) return;
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    g.fillStyle = '#12161a';
    g.fillRect(0, 0, W, H);
    if (!an) return;
    if (!fbuf.current || fbuf.current.length !== an.frequencyBinCount) fbuf.current = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(fbuf.current);
    // spectrum (log x)
    const bins = fbuf.current;
    const n = bins.length;
    g.fillStyle = 'rgba(255,154,60,0.35)';
    for (let x = 0; x < W; x += 2) {
      const f0 = Math.floor(Math.pow(n, x / W));
      const v = bins[Math.min(n - 1, f0)] / 255;
      g.fillRect(x, H - v * H, 2, v * H);
    }
    // waveform
    if (!buf.current || buf.current.length !== an.fftSize) buf.current = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf.current);
    const d = buf.current;
    // find a rising zero crossing for a stable picture
    let s0 = 0;
    for (let i = 1; i < d.length / 2; i++) if (d[i - 1] < 0 && d[i] >= 0) { s0 = i; break; }
    g.strokeStyle = '#9fe870';
    g.lineWidth = 1.2;
    g.beginPath();
    const span = Math.min(d.length - s0, 1024);
    for (let x = 0; x < W; x++) {
      const v = d[s0 + Math.floor((x / W) * span)] ?? 0;
      const y = H / 2 - v * (H / 2) * 0.95;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  });
  return <canvas ref={ref} className="scope" width={width} height={height} style={{ width, height }} title="Master output: oscilloscope + spectrum" />;
}
