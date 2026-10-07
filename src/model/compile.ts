// Compiles a Strudel Studio project into Strudel code.
// 1 bar == 1 Strudel cycle, tempo via setcpm(bpm / beatsPerBar).

import type { Channel, Clip, ID, MixerInsert, Note, Pattern, PlayMode, Project } from './types';
import { stepsPerBar, ticksPerBar } from './types';
import { CHANNEL_CORE_AUTOMATION, CHANNEL_PARAMS, CHANNEL_PARAM_MAP, VOWELS, fromNorm, type ParamDef } from './paramDefs';
import { gcd, ident, midiToStrudel, num, uniqueIdent, RESERVED } from './util';
import { getSteps } from './factory';
import { PLUGIN_SDK_SOURCE, singleQuoted } from '../plugins/sdk';

export interface PluginInfo {
  id: string;
  name: string;
  params: (ParamDef & { control: string })[];
  source: string;
}

export interface CompileOptions {
  mode: PlayMode;
  patternId?: ID;
  /** include plugin sources so the code runs standalone on strudel.cc */
  forExport?: boolean;
  getPlugin?: (id: string) => PluginInfo | undefined;
  /** code channels that failed validation (skipped) */
  invalidCodeChannels?: Set<ID>;
  /** identifiers that must not be shadowed (strudel scope functions) */
  reservedNames?: Set<string>;
  /** ids of all installed plugins (to detect plugin use inside code channels / live code) */
  allPluginIds?: string[];
}

export interface CompileResult {
  code: string;
  /** definitions only (used as a prelude for the live code editor) */
  preamble: string;
  songBars: number;
  channelIdents: Record<ID, string>;
  patternIdents: Record<ID, string>;
  usedPlugins: string[];
  warnings: string[];
}

const PAD = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

export function songLengthBars(project: Project): number {
  let end = 0;
  for (const c of project.clips) end = Math.max(end, c.start + c.length);
  return Math.max(1, Math.ceil(end - 1e-9));
}

// ---------------------------------------------------------------- content
function hasContent(project: Project, pattern: Pattern, ch: Channel): boolean {
  if (ch.kind === 'code') return !!pattern.code[ch.id] && !!ch.code.trim();
  if ((pattern.notes[ch.id]?.length ?? 0) > 0) return true;
  return (pattern.steps[ch.id] ?? []).some((v) => v > 0);
}

function velStr(v: number) {
  return num(Math.max(0, Math.min(1, v)), 2);
}

/** weight suffix for mini-notation */
const w = (n: number) => (n === 1 ? '' : '@' + n);

function stepsToMini(project: Project, pattern: Pattern, ch: Channel, token: string) {
  const steps = getSteps(project, pattern, ch.id);
  const spb = stepsPerBar(project);
  const bars: string[] = [];
  const vbars: string[] = [];
  let uniform: number | null = null;
  let isUniform = true;
  for (let b = 0; b < pattern.bars; b++) {
    const toks: string[] = [];
    const vtoks: string[] = [];
    for (let i = 0; i < spb; i++) {
      const v = steps[b * spb + i] ?? 0;
      if (v > 0) {
        toks.push(token);
        vtoks.push(velStr(v));
        if (uniform === null) uniform = v;
        else if (Math.abs(uniform - v) > 1e-6) isUniform = false;
      } else {
        toks.push('~');
        vtoks.push('~');
      }
    }
    bars.push(toks.join(' '));
    vbars.push(vtoks.join(' '));
  }
  const multi = pattern.bars > 1;
  const seq = multi ? bars.map((b) => `[${b}]`).join(' ') : bars[0];
  const vseq = multi ? vbars.map((b) => `[${b}]`).join(' ') : vbars[0];
  let velocity = '';
  if (!isUniform) velocity = `.velocity("${vseq}")`;
  else if (uniform !== null && Math.abs(uniform - 1) > 1e-6) velocity = `.velocity(${velStr(uniform)})`;
  return { seq, velocity };
}

interface Group {
  start: number;
  len: number;
  vel: number;
  keys: number[];
}

/** converts piano roll notes into one or more monophonic mini-notation voices */
export function notesToVoices(notes: Note[], totalTicks: number, barTicks: number, transpose: number) {
  // group chords (same start, len & velocity)
  const map = new Map<string, Group>();
  for (const n of notes) {
    const start = Math.max(0, Math.round(n.start));
    if (start >= totalTicks) continue;
    const end = Math.min(totalTicks, Math.round(n.start + n.len));
    const len = end - start;
    if (len <= 0) continue;
    const vel = Math.round(n.vel * 100) / 100;
    const k = `${start}|${len}|${vel}`;
    const g = map.get(k) ?? { start, len, vel, keys: [] };
    g.keys.push(n.key + transpose);
    map.set(k, g);
  }
  const groups = [...map.values()].sort((a, b) => a.start - b.start || b.len - a.len);
  groups.forEach((g) => g.keys.sort((a, b) => a - b));
  // greedy voice allocation
  const voices: { end: number; groups: Group[] }[] = [];
  for (const g of groups) {
    let v = voices.find((v) => v.end <= g.start);
    if (!v) {
      v = { end: 0, groups: [] };
      voices.push(v);
    }
    v.groups.push(g);
    v.end = g.start + g.len;
  }
  return voices.map((v) => voiceToMini(v.groups, totalTicks, barTicks));
}

function voiceToMini(groups: Group[], totalTicks: number, barTicks: number) {
  let g = gcd(totalTicks, barTicks);
  for (const x of groups) g = gcd(gcd(g, x.start), x.len);
  g = Math.max(1, g);
  const bars = Math.round(totalTicks / barTicks);
  const crossesBar = groups.some((x) => Math.floor(x.start / barTicks) !== Math.floor((x.start + x.len - 1) / barTicks));
  const useBarGroups = bars > 1 && !crossesBar;

  const vels = new Set(groups.map((x) => x.vel));
  const uniformVel = vels.size <= 1 ? (groups[0]?.vel ?? 1) : null;

  const emit = (from: number, to: number, list: Group[]) => {
    const toks: string[] = [];
    const vtoks: string[] = [];
    let t = from;
    for (const x of list) {
      if (x.start > t) {
        toks.push('~' + w((x.start - t) / g));
        vtoks.push('~' + w((x.start - t) / g));
      }
      const name = x.keys.length > 1 ? `[${x.keys.map(midiToStrudel).join(',')}]` : midiToStrudel(x.keys[0]);
      toks.push(name + w(x.len / g));
      vtoks.push(velStr(x.vel) + w(x.len / g));
      t = x.start + x.len;
    }
    if (to > t) {
      toks.push('~' + w((to - t) / g));
      vtoks.push('~' + w((to - t) / g));
    }
    return { s: toks.join(' '), v: vtoks.join(' ') };
  };

  let seq: string;
  let vseq: string;
  if (useBarGroups) {
    const parts: string[] = [];
    const vparts: string[] = [];
    for (let b = 0; b < bars; b++) {
      const from = b * barTicks;
      const list = groups.filter((x) => x.start >= from && x.start < from + barTicks);
      const r = emit(from, from + barTicks, list);
      const single = !r.s.includes(' ') || (r.s.startsWith('[') && r.s.endsWith(']') && !/\]\s/.test(r.s));
      if (single) {
        // one token fills the whole bar: no brackets / weights needed
        parts.push(r.s.replace(/@\d+$/, ''));
        vparts.push(r.v.replace(/@\d+$/, ''));
      } else {
        parts.push(`[${r.s}]`);
        vparts.push(`[${r.v}]`);
      }
    }
    seq = parts.join(' ');
    vseq = vparts.join(' ');
  } else {
    const r = emit(0, totalTicks, groups);
    seq = r.s;
    vseq = r.v;
  }
  let velocity = '';
  if (uniformVel === null) velocity = `.velocity("${vseq}")`;
  else if (Math.abs(uniformVel - 1) > 1e-6) velocity = `.velocity(${velStr(uniformVel)})`;
  return { seq, velocity };
}

function swingSuffix(project: Project) {
  if (project.swing <= 0.001) return '';
  const x = project.swing * (2 / 3);
  return `.swingBy(${num(x, 3)}, ${stepsPerBar(project) / 2})`;
}

/** Strudel expression producing the channel's events for one pattern (length = pattern.bars cycles) */
export function channelContent(project: Project, pattern: Pattern, ch: Channel, opts: CompileOptions): string | null {
  if (!hasContent(project, pattern, ch)) return null;
  const slow = pattern.bars > 1 ? `.slow(${pattern.bars})` : '';
  const transpose = Math.round(ch.params.transpose ?? 0);

  if (ch.kind === 'code') {
    if (opts.invalidCodeChannels?.has(ch.id)) return null;
    const code = ch.code.trim().replace(/;+\s*$/, '');
    return `(${code.includes('\n') || code.includes('//') ? '\n' + indent(code, 4) + '\n  ' : code})`;
  }

  const notes = pattern.notes[ch.id] ?? [];
  if (notes.length > 0) {
    const voices = notesToVoices(notes, pattern.bars * ticksPerBar(project), ticksPerBar(project), transpose);
    const sampleSuffix = ch.kind === 'sample' ? `.s(${JSON.stringify(ch.sound)})` : '';
    const exprs = voices.map((v) => `note("${v.seq}")${v.velocity}${sampleSuffix}${slow}`);
    if (exprs.length === 1) return exprs[0];
    return `stack(\n${exprs.map((e) => '    ' + e).join(',\n')}\n  )`;
  }

  // steps
  const token = ch.kind === 'sample' ? ch.sound : midiToStrudel(ch.rootNote + transpose);
  const { seq, velocity } = stepsToMini(project, pattern, ch, token);
  const fn = ch.kind === 'sample' ? 's' : 'note';
  return `${fn}("${seq}")${velocity}${slow}${swingSuffix(project)}`;
}

function indent(s: string, n: number) {
  const pad = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

// ---------------------------------------------------------------- chains
function insertChain(ins: MixerInsert, index: number, project: Project): string {
  const parts = [`.orbit(${index})`];
  if (ins.reverb > 0.001) {
    parts.push(`.room(${num(ins.reverb)})`, `.roomsize(${num(ins.reverbSize, 2)})`);
    if (ins.reverbLp < 19999) parts.push(`.roomlp(${Math.round(ins.reverbLp)})`);
  }
  if (ins.delay > 0.001) {
    parts.push(`.delay(${num(ins.delay)})`, `.delaysync(${num(ins.delaySteps / stepsPerBar(project), 4)})`, `.delayfeedback(${num(ins.delayFeedback)})`);
  }
  if (Math.abs(ins.djf - 0.5) > 0.01) parts.push(`.djf(${num(ins.djf)})`);
  const targets = ins.duckTargets.filter((t) => t > 0 && t < project.mixer.length && t !== index);
  if (targets.length) {
    parts.push(
      `.duckorbit(${targets.length === 1 ? targets[0] : JSON.stringify(targets.join(':'))})`,
      `.duckdepth(${num(ins.duckDepth)})`,
      `.duckattack(${num(ins.duckRelease)})`,
    );
  }
  return parts.join('');
}

function paramValueCode(def: ParamDef, v: number): string | null {
  if (def.key === 'transpose') return null;
  if (def.key === 'vowel') {
    const vw = VOWELS[Math.round(v)] ?? '';
    return vw ? `.vowel("${vw}")` : null;
  }
  if (def.key === 'crush' && v >= 16) return null;
  if (def.key === 'coarse' && v <= 1) return null;
  if (def.key === 'cutoff' && v >= 19999) return null;
  if (def.key === 'hcutoff' && v <= 20) return null;
  return `.${def.control}(${num(v, 4)})`;
}

/** VST3 channels are played by the native app: .s("native").vst(channelId) forwards the notes */
function vstChain(ch: Channel, opts: CompileOptions): string {
  const parts: string[] = [];
  if (opts.forExport) {
    // strudel.cc can't host VST3 plug-ins: a simple stand-in synth keeps the part audible
    parts.push(`.s("triangle")`, `.gain(${num(ch.volume * 0.8)})`);
  } else {
    parts.push(`.s("native")`, `.vst('${ch.id.replace(/[^\w]/g, '')}')`, `.gain(${num(ch.volume)})`);
  }
  if (Math.abs(ch.pan - 0.5) > 0.001) parts.push(`.pan(${num(ch.pan)})`);
  parts.push(`.color("${ch.color}")`);
  return parts.join('');
}

function channelChain(project: Project, ch: Channel, opts: CompileOptions, warnings: string[]): string {
  if (ch.kind === 'vst') return vstChain(ch, opts);
  const parts: string[] = [];
  const plugin = ch.kind === 'plugin' ? opts.getPlugin?.(ch.sound) : undefined;
  if (ch.kind === 'synth' || ch.kind === 'soundfont' || ch.kind === 'plugin') parts.push(`.s(${JSON.stringify(ch.sound)})`);
  if (ch.kind === 'sample' && ch.bank) parts.push(`.bank(${JSON.stringify(ch.bank)})`);
  if ((ch.kind === 'sample' || ch.kind === 'soundfont') && ch.n) parts.push(`.n(${ch.n})`);
  parts.push(`.gain(${num(ch.volume)})`);
  if (Math.abs(ch.pan - 0.5) > 0.001) parts.push(`.pan(${num(ch.pan)})`);

  // pitch for sample steps: transpose -> speed
  const transpose = Math.round(ch.params.transpose ?? 0);
  for (const def of CHANNEL_PARAMS) {
    if (def.kinds && !def.kinds.includes(ch.kind)) continue;
    let v = ch.params[def.key];
    if (def.key === 'speed' && ch.kind === 'sample' && transpose !== 0) {
      // speed is combined with transpose for step-sequenced samples (notes are transposed directly)
      continue;
    }
    if (v === undefined || v === null || !isFinite(v)) continue;
    const c = paramValueCode(def, v);
    if (c) parts.push(c);
  }
  if (ch.kind === 'sample' && (transpose !== 0 || ch.params.speed !== undefined)) {
    // only affects step content (note content is transposed directly & overrides pitch)
    const sp = (ch.params.speed ?? 1) * Math.pow(2, transpose / 12);
    if (Math.abs(sp - 1) > 1e-4) parts.push(`.speed(${num(sp, 4)})`);
  }
  if (ch.kind === 'plugin') {
    if (!plugin) warnings.push(`Plugin "${ch.sound}" used by channel "${ch.name}" is not installed`);
    else {
      for (const p of plugin.params) {
        const v = ch.pluginParams[p.key];
        if (v === undefined || Math.abs(v - p.def) < 1e-9) continue;
        parts.push(`.${p.control}(${num(v, 4)})`);
      }
    }
  }
  parts.push(`.color("${ch.color}")`);
  return parts.join('');
}

// ---------------------------------------------------------------- automation
function automationDef(project: Project, ch: Channel, param: string, opts: CompileOptions): ParamDef | undefined {
  const core = CHANNEL_CORE_AUTOMATION.find((d) => d.key === param);
  if (core) return core;
  if (param.startsWith('plugin:')) {
    const key = param.slice(7);
    const pl = ch.kind === 'plugin' ? opts.getPlugin?.(ch.sound) : undefined;
    return pl?.params.find((p) => p.key === key);
  }
  const d = CHANNEL_PARAM_MAP[param];
  return d?.automatable ? d : undefined;
}

export const AUTOMATION_HELPER = `// automation curve: piecewise-linear [bar, value] points, looping every \`len\` bars
const curve = (len, pts) => signal(t => {
  t = ((t % len) + len) % len
  let i = 0
  while (i < pts.length && pts[i][0] <= t) i++
  if (i === 0) return pts[0][1]
  if (i === pts.length) return pts[pts.length - 1][1]
  const [t0, v0] = pts[i - 1], [t1, v1] = pts[i]
  return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0)
})`;

function buildAutomation(project: Project, song: number, activeTracks: Set<number>, opts: CompileOptions) {
  // channelId -> param -> points
  const out = new Map<ID, Map<string, { def: ParamDef; pts: [number, number][] }>>();
  const clips = project.clips
    .filter((c) => c.kind === 'automation' && c.automation?.target && activeTracks.has(c.track))
    .sort((a, b) => a.start - b.start);
  for (const c of clips) {
    const t = c.automation!.target!;
    const ch = project.channels.find((x) => x.id === t.channelId);
    if (!ch) continue;
    const def = automationDef(project, ch, t.param, opts);
    if (!def) continue;
    const pts = [...c.automation!.points].sort((a, b) => a.x - b.x);
    if (!pts.length) continue;
    let byParam = out.get(ch.id);
    if (!byParam) out.set(ch.id, (byParam = new Map()));
    let entry = byParam.get(t.param);
    if (!entry) byParam.set(t.param, (entry = { def, pts: [] }));
    // hold previous value until this clip starts
    if (entry.pts.length) entry.pts.push([c.start, entry.pts[entry.pts.length - 1][1]]);
    for (const p of pts) entry.pts.push([Math.min(song, c.start + p.x * c.length), fromNorm(def, p.y)]);
  }
  return out;
}

// ---------------------------------------------------------------- arrangement
interface Section {
  start: number;
  len: number;
  expr: string;
  needsRibbon: boolean;
}

function mergeSections(sections: Section[]): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    const prev = out[out.length - 1];
    if (prev && prev.expr === s.expr && !prev.needsRibbon && !s.needsRibbon && Math.abs(prev.start + prev.len - s.start) < 1e-9) {
      prev.len += s.len;
    } else out.push({ ...s });
  }
  return out;
}

function arrangeExpr(sections: Section[], song: number): string {
  sections = mergeSections(sections);
  const parts: string[] = [];
  let t = 0;
  for (const s of sections) {
    if (s.start > t + 1e-9) parts.push(`[${num(s.start - t, 4)}, silence]`);
    parts.push(`[${num(s.len, 4)}, ${s.expr}${s.needsRibbon ? `.ribbon(0, ${num(s.len, 4)})` : ''}]`);
    t = s.start + s.len;
  }
  if (song > t + 1e-9) parts.push(`[${num(song - t, 4)}, silence]`);
  return `arrange(${parts.join(', ')})`;
}

// ---------------------------------------------------------------- main
export function compileProject(project: Project, opts: CompileOptions): CompileResult {
  const warnings: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i <= 64; i++) used.add('mix' + i);
  used.add('curve');
  RESERVED.forEach((n) => used.add(n));
  opts.reservedNames?.forEach((n) => used.add(n));
  // readable identifiers; on a clash with strudel's scope (e.g. "beat", "piano") add a suffix
  const nameFor = (raw: string, fallback: string, digitPrefix: string, suffix: string) => {
    let b = ident(raw, fallback, digitPrefix);
    if (used.has(b)) b = b + suffix;
    return uniqueIdent(b, used);
  };

  const L: string[] = [];
  const modeLabel = opts.mode === 'song' ? 'song' : opts.mode === 'pattern' ? 'pattern' : 'live';
  L.push(`// Strudel Studio · "${project.name.replace(/"/g, "'")}" · ${project.bpm} BPM · ${project.beatsPerBar}/4 · ${modeLabel} mode`);
  L.push(`// 1 cycle = 1 bar. Generated from the project — paste into https://strudel.cc to play it anywhere.`);
  L.push(`setcpm(${num(project.bpm, 3)}/${project.beatsPerBar})`);

  // which channels are audible
  const anySolo = project.channels.some((c) => c.solo);
  const audible = project.channels.filter((c) => !c.mute && (!anySolo || c.solo));

  // plugins
  const usedPlugins = [...new Set(project.channels.filter((c) => c.kind === 'plugin').map((c) => c.sound))];
  // plugins referenced from code channels or the live code, e.g. .s("fmkeys").fmkeys_index(3)
  const freeCode = [...project.channels.filter((c) => c.kind === 'code').map((c) => c.code), opts.mode === 'live' ? project.liveCode : ''].join('\n');
  for (const id of opts.allPluginIds ?? []) {
    if (!usedPlugins.includes(id) && new RegExp(`["'\`]${id}["'\`]|\\b${id}_\\w+\\(`).test(freeCode)) usedPlugins.push(id);
  }
  if (opts.forExport && usedPlugins.length) {
    L.push('');
    L.push('// ── Plugin instruments (portable Strudel Studio plugins: plain registerSound + registerControl) ──');
    L.push(PLUGIN_SDK_SOURCE);
    const seen = new Set<string>();
    for (const id of usedPlugins) {
      const pl = opts.getPlugin?.(id);
      if (pl && !seen.has(pl.source)) {
        seen.add(pl.source);
        L.push(`// plugin: ${pl.name}`);
        if (/["`]/.test(pl.source)) {
          // keep strings that strudel would parse as mini-notation intact
          L.push(`Function('definePlugin', ${singleQuoted(pl.source.trim())})(definePlugin)`);
        } else {
          L.push('{');
          L.push(indent(pl.source.trim(), 2));
          L.push('}');
        }
      } else if (!pl) {
        warnings.push(`Plugin "${id}" is not installed`);
      }
    }
  }
  if (opts.forExport) {
    const nativeFx = project.mixer.some((m) => m.fx.some((f) => f.enabled && f.pluginId !== 'limiter'));
    if (nativeFx) L.push(`// note: mixer insert effects (EQ, compressor, chorus, ...) are Strudel Studio native and not included here`);
  }

  // mixer inserts
  const usedInserts = [...new Set(audible.map((c) => c.insert))].filter((i) => i > 0 && i < project.mixer.length).sort((a, b) => a - b);
  if (usedInserts.length) {
    L.push('');
    L.push('// ── Mixer inserts (one orbit each: reverb, delay, sidechain) ──');
    for (const i of usedInserts) {
      const ins = project.mixer[i];
      L.push(`${PAD(`const mix${i} = p => p${insertChain(ins, i, project)}`, 60)} // ${ins.name}`);
    }
  }

  // channels
  const channelIdents: Record<ID, string> = {};
  const chLines: string[] = [];
  for (const ch of project.channels) {
    const id = nameFor(ch.name, 'channel', 'ch', 'Ch');
    channelIdents[ch.id] = id;
    const chain = channelChain(project, ch, opts, warnings);
    const insert = ch.insert > 0 && ch.insert < project.mixer.length ? ch.insert : 0;
    const nativeVst = ch.kind === 'vst' && !opts.forExport;
    const body = nativeVst ? `p${chain}` : insert > 0 ? `mix${insert}(p${chain})` : `p${chain}.orbit(0)`;
    const flags = [
      ch.mute ? 'muted' : '',
      ch.solo ? 'solo' : '',
      ch.kind === 'vst' ? `VST3: ${(ch.vst?.name ?? 'no plug-in').replace(/\n/g, ' ')}${opts.forExport ? ' (Strudel Studio native app only, triangle stand-in)' : ''}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    chLines.push(`const ${id} = p => ${body}${flags ? ' // ' + flags : ''}`);
  }
  if (chLines.length) {
    L.push('');
    L.push('// ── Channel rack (instrument chains) ──');
    L.push(...chLines);
  }

  // which patterns do we need?
  const song = songLengthBars(project);
  const activeTracks = new Set(project.tracks.map((t, i) => (t.mute ? -1 : i)).filter((i) => i >= 0));
  let neededPatterns: Pattern[];
  if (opts.mode === 'song') {
    const ids = new Set(project.clips.filter((c) => c.kind === 'pattern' && activeTracks.has(c.track)).map((c) => c.patternId));
    neededPatterns = project.patterns.filter((p) => ids.has(p.id));
  } else if (opts.mode === 'live') {
    neededPatterns = project.patterns;
  } else {
    neededPatterns = project.patterns.filter((p) => p.id === opts.patternId);
  }

  // patterns
  const patternIdents: Record<ID, string> = {};
  const contents = new Map<ID, Map<ID, string>>(); // pattern -> channel -> expr
  const patLines: string[] = [];
  for (const p of neededPatterns) {
    const id = nameFor(p.name, 'pattern', 'pat', 'Pat');
    patternIdents[p.id] = id;
    const m = new Map<ID, string>();
    const entries: string[] = [];
    for (const ch of project.channels) {
      const expr = channelContent(project, p, ch, opts);
      if (!expr) continue;
      m.set(ch.id, expr);
      entries.push(`  ${channelIdents[ch.id]}: ${expr},`);
    }
    contents.set(p.id, m);
    const comment = ` // "${p.name.replace(/\n/g, ' ')}" · ${p.bars} bar${p.bars > 1 ? 's' : ''}`;
    if (entries.length) {
      patLines.push(`const ${id} = {${comment}`);
      patLines.push(...entries);
      patLines.push('}');
    } else {
      patLines.push(`const ${id} = {}${comment}`);
    }
  }
  if (patLines.length) {
    L.push('');
    L.push('// ── Patterns ──');
    L.push(...patLines);
  }

  // automation
  const automation = opts.mode === 'song' ? buildAutomation(project, song, activeTracks, opts) : new Map();
  if (automation.size) {
    L.push('');
    L.push(AUTOMATION_HELPER);
  }

  const preamble = L.join('\n');
  const P: string[] = [];

  if (opts.mode === 'pattern') {
    const p = neededPatterns[0];
    P.push('');
    if (!p) {
      P.push('// no pattern selected');
    } else {
      P.push(`// ── Playing pattern "${p.name}" ──`);
      const m = contents.get(p.id)!;
      let any = false;
      for (const ch of audible) {
        if (!m.has(ch.id)) continue;
        any = true;
        P.push(`${channelIdents[ch.id]}: ${channelIdents[ch.id]}(${patternIdents[p.id]}.${channelIdents[ch.id]})`);
      }
      if (!any) P.push('// (pattern is empty — add steps in the channel rack or notes in the piano roll)');
    }
  } else if (opts.mode === 'song') {
    P.push('');
    P.push(`// ── Song: ${song} bar${song > 1 ? 's' : ''} (playlist) ──`);
    let any = false;
    for (const ch of audible) {
      // gather clips containing this channel
      const secs: Section[] = [];
      for (const c of project.clips) {
        if (c.kind !== 'pattern' || !activeTracks.has(c.track) || !c.patternId) continue;
        const expr = contents.get(c.patternId)?.get(ch.id);
        if (!expr) continue;
        const pat = project.patterns.find((p) => p.id === c.patternId)!;
        const len = Math.max(0, Math.min(c.length, song - c.start));
        if (len <= 0) continue;
        const needsRibbon = ch.kind === 'code' || Math.abs(len / pat.bars - Math.round(len / pat.bars)) > 1e-6;
        secs.push({ start: c.start, len, expr: `${patternIdents[pat.id]}.${channelIdents[ch.id]}`, needsRibbon });
      }
      if (!secs.length) continue;
      any = true;
      secs.sort((a, b) => a.start - b.start);
      // split overlapping clips into lanes
      const lanes: Section[][] = [];
      for (const s of secs) {
        let lane = lanes.find((l) => l[l.length - 1].start + l[l.length - 1].len <= s.start + 1e-9);
        if (!lane) lanes.push((lane = []));
        lane.push(s);
      }
      const arr = lanes.map((l) => arrangeExpr(l, song));
      const body = arr.length === 1 ? arr[0] : `stack(\n  ${arr.join(',\n  ')}\n)`;
      let line = `${channelIdents[ch.id]}: ${channelIdents[ch.id]}(${body})`;
      const autos = automation.get(ch.id);
      if (autos) {
        for (const [, { def, pts }] of autos) {
          const ptsCode = pts.map(([t, v]: [number, number]) => `[${num(t, 4)}, ${num(v, 4)}]`).join(', ');
          line += `.${def.control}(curve(${song}, [${ptsCode}]))`;
        }
      }
      P.push(line);
    }
    if (!any) P.push('// (playlist is empty — paint patterns into the playlist to build a song)');
  } else {
    P.push('');
    P.push('// ── Live code ──');
    P.push(project.liveCode);
  }

  return {
    code: preamble + '\n' + P.join('\n') + '\n',
    preamble: preamble + '\n',
    songBars: song,
    channelIdents,
    patternIdents,
    usedPlugins,
    warnings,
  };
}

/** helper for the UI: does a clip reference a pattern with content for a channel */
export function clipHasChannel(project: Project, clip: Clip, chId: ID) {
  const p = project.patterns.find((x) => x.id === clip.patternId);
  const ch = project.channels.find((c) => c.id === chId);
  return !!p && !!ch && hasContent(project, p, ch);
}
export { hasContent };
