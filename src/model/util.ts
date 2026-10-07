let counter = 0;
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7) + counter.toString(36);
}

export const PALETTE = [
  '#ff8a3d', '#ffc53d', '#9be15d', '#3ddc97', '#3dc6ff', '#5b8cff', '#a77bff',
  '#ff6bcb', '#ff5d5d', '#d4a373', '#8ecae6', '#b5e48c', '#f28482', '#84a59d',
];

export function paletteColor(i: number) {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** returns a color not present in `used` (small hue/lightness tweaks if needed) */
export function uniqueColor(base: string, used: Set<string>): string {
  let c = base.toLowerCase();
  let i = 0;
  while (used.has(c) && i < 400) {
    i++;
    c = tweakColor(base, i);
  }
  return c;
}

function tweakColor(hex: string, i: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  const d = ((i % 2 ? 1 : -1) * Math.ceil(i / 2)) | 0;
  r = Math.max(0, Math.min(255, r + d));
  g = Math.max(0, Math.min(255, g - d));
  b = Math.max(0, Math.min(255, b + ((i * 7) % 5) - 2));
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function hexToRgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------- notes ----------------
const NAMES_FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** strudel note name, e.g. 60 -> c4, 63 -> eb4 */
export function midiToStrudel(m: number): string {
  const oct = Math.floor(m / 12) - 1;
  return NAMES_FLAT[((m % 12) + 12) % 12] + oct;
}
/** display name, e.g. 61 -> C#4 */
export function midiToName(m: number): string {
  const oct = Math.floor(m / 12) - 1;
  return NAMES_SHARP[((m % 12) + 12) % 12] + oct;
}
export function isBlackKey(m: number) {
  return [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
}

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

/** compact number formatting for code: 0.5 -> .5? we keep leading zero for readability */
export function num(v: number, digits = 3): string {
  if (!isFinite(v)) return '0';
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return String(r);
}

export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/** sanitize to a JS identifier */
export function ident(name: string, fallback = 'x', digitPrefix = 'x'): string {
  let s = name
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/\s/g, '');
  s = s.replace(/^_+|_+$/g, ''); // leading/trailing _ would mute the pattern in strudel
  if (!s) s = fallback;
  if (/^\d/.test(s)) s = digitPrefix + s;
  s = s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}

export const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield let static enum await implements package protected interface private public null true false undefined ' +
    // strudel globals we must not shadow
    's n note sound stack cat seq arrange silence pure sine saw square tri rand perlin irand run scale chord samples hush setcpm setcps all each mix gain pan orbit room delay bank signal ribbon slow fast rev jux mini m register'
  ).split(' '),
);

export function uniqueIdent(base: string, used: Set<string>): string {
  let s = base;
  let i = 2;
  while (used.has(s)) s = base + i++;
  used.add(s);
  return s;
}

export function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}
