import type { Channel, ChannelKind, Clip, ID, Note, Pattern, Project } from '../model/types';
import { stepsPerBar, ticksPerBar, TICKS_PER_STEP } from '../model/types';
import { createChannel, createClip, createFxSlot, createPattern, getSteps, nextFreeInsert } from '../model/factory';
import { uid, uniqueColor, paletteColor, deepClone } from '../model/util';
import { EFFECT_MAP } from '../plugins/effects';
import { getState, useStudio, fixSelection } from './store';
import type { LibItem } from '../engine/library';
import { prettySoundName } from '../engine/library';
import { getPlugin } from '../plugins/registry';

const up = (fn: (p: Project) => void, coalesce?: string) => getState().update(fn as never, coalesce);

// ------------------------------------------------------------------ channels
export function addChannel(init: Partial<Channel> & { kind: ChannelKind }, select = true): ID {
  const s = getState();
  const ch = createChannel(s.project, { insert: nextFreeInsert(s.project), ...init });
  up((p) => {
    p.channels.push(ch);
    const ins = p.mixer[ch.insert];
    if (ch.insert > 0 && ins && /^Insert \d+$/.test(ins.name)) {
      ins.name = ch.name;
      ins.color = ch.color;
    }
  });
  if (select) useStudio.setState({ channelId: ch.id });
  return ch.id;
}

export function channelFromLibrary(item: LibItem): Partial<Channel> & { kind: ChannelKind } {
  const pl = item.kind === 'plugin' ? getPlugin(item.sound) : undefined;
  return {
    kind: item.kind,
    sound: item.sound,
    bank: item.bank ?? '',
    n: item.n ?? 0,
    name: pl?.name ?? (item.bank ? `${prettySoundName(item.sound)}` : item.label),
    rootNote: item.rootNote ?? (item.kind === 'sample' ? 36 : 60),
  };
}

export function addChannelFromLibrary(item: LibItem) {
  return addChannel(channelFromLibrary(item));
}

/** replace the sound of an existing channel (drag from browser onto a channel) */
export function replaceChannelSound(chId: ID, item: LibItem) {
  const init = channelFromLibrary(item);
  up((p) => {
    const ch = p.channels.find((c) => c.id === chId);
    if (!ch) return;
    const wasDefaultName = ch.name === prettySoundName(ch.sound) || ch.name === ch.sound;
    ch.kind = init.kind;
    ch.sound = init.sound!;
    ch.bank = init.bank ?? '';
    ch.n = init.n ?? 0;
    if (wasDefaultName) ch.name = init.name!;
    if (init.kind !== 'plugin') ch.pluginParams = {};
  });
}

export function setChannel(id: ID, patch: Partial<Channel>, coalesce?: string) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === id);
    if (ch) Object.assign(ch, patch);
  }, coalesce);
}

export function setChannelParam(id: ID, key: string, value: number | undefined) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === id);
    if (!ch) return;
    if (value === undefined) delete ch.params[key];
    else ch.params[key] = value;
  }, `param:${id}:${key}`);
}

export function setPluginParam(id: ID, key: string, value: number | undefined) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === id);
    if (!ch) return;
    if (value === undefined) delete ch.pluginParams[key];
    else ch.pluginParams[key] = value;
  }, `pparam:${id}:${key}`);
}

export function deleteChannel(id: ID) {
  up((p) => {
    p.channels = p.channels.filter((c) => c.id !== id);
    for (const pt of p.patterns) {
      delete pt.steps[id];
      delete pt.notes[id];
      delete pt.code[id];
    }
    p.clips = p.clips.filter((c) => !(c.kind === 'automation' && c.automation?.target?.channelId === id));
  });
  fixSelection();
}

export function cloneChannel(id: ID) {
  const s = getState();
  const src = s.project.channels.find((c) => c.id === id);
  if (!src) return;
  const used = new Set(s.project.channels.map((c) => c.color));
  const copy: Channel = { ...deepClone(src), id: uid('ch'), name: src.name + ' 2', color: uniqueColor(src.color, used), solo: false };
  up((p) => {
    const idx = p.channels.findIndex((c) => c.id === id);
    p.channels.splice(idx + 1, 0, copy);
    for (const pt of p.patterns) {
      if (pt.steps[id]) pt.steps[copy.id] = [...pt.steps[id]];
      if (pt.notes[id]) pt.notes[copy.id] = pt.notes[id].map((n) => ({ ...n, id: uid('n') }));
      if (pt.code[id]) pt.code[copy.id] = pt.code[id];
    }
  });
}

export function moveChannel(id: ID, dir: -1 | 1) {
  up((p) => {
    const i = p.channels.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.channels.length) return;
    const [c] = p.channels.splice(i, 1);
    p.channels.splice(j, 0, c);
  });
}

export function toggleMute(id: ID) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === id);
    if (ch) ch.mute = !ch.mute;
  });
}

export function toggleSolo(id: ID) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === id);
    if (!ch) return;
    const on = !ch.solo;
    p.channels.forEach((c) => (c.solo = false));
    ch.solo = on;
  });
}

// ------------------------------------------------------------------ patterns
export function selectPattern(id: ID) {
  useStudio.setState({ patternId: id });
}

export function addPattern(name?: string) {
  const s = getState();
  const pt = createPattern(s.project, name);
  up((p) => {
    p.patterns.push(pt);
  });
  selectPattern(pt.id);
  return pt.id;
}

export function clonePattern(id: ID) {
  const s = getState();
  const src = s.project.patterns.find((p) => p.id === id);
  if (!src) return;
  const copy: Pattern = { ...deepClone(src), id: uid('pt'), name: src.name + ' (copy)', color: paletteColor(s.project.patterns.length + 3) };
  for (const k of Object.keys(copy.notes)) copy.notes[k] = copy.notes[k].map((n) => ({ ...n, id: uid('n') }));
  up((p) => {
    p.patterns.push(copy);
  });
  selectPattern(copy.id);
  return copy.id;
}

export function deletePattern(id: ID) {
  const s = getState();
  if (s.project.patterns.length <= 1) return;
  up((p) => {
    p.patterns = p.patterns.filter((x) => x.id !== id);
    p.clips = p.clips.filter((c) => c.patternId !== id);
  });
  fixSelection();
}

export function setPattern(id: ID, patch: Partial<Pattern>) {
  up((p) => {
    const pt = p.patterns.find((x) => x.id === id);
    if (pt) Object.assign(pt, patch);
  });
}

export function setPatternBars(id: ID, bars: number) {
  bars = Math.max(1, Math.min(64, Math.round(bars)));
  up((p) => {
    const pt = p.patterns.find((x) => x.id === id);
    if (!pt) return;
    pt.bars = bars;
    const n = bars * stepsPerBar(p);
    for (const k of Object.keys(pt.steps)) {
      const s = pt.steps[k];
      pt.steps[k] = Array.from({ length: n }, (_, i) => s[i] ?? 0);
    }
  });
}

// ------------------------------------------------------------------ steps
export function setStep(patternId: ID, chId: ID, i: number, vel: number, coalesce?: string) {
  up((p) => {
    const pt = p.patterns.find((x) => x.id === patternId);
    if (!pt) return;
    const steps = getSteps(p, pt, chId).slice();
    if (i < 0 || i >= steps.length) return;
    steps[i] = Math.max(0, Math.min(1, vel));
    pt.steps[chId] = steps;
  }, coalesce);
}

export function editSteps(patternId: ID, chId: ID, fn: (steps: number[]) => number[] | void) {
  up((p) => {
    const pt = p.patterns.find((x) => x.id === patternId);
    if (!pt) return;
    const steps = getSteps(p, pt, chId).slice();
    const r = fn(steps);
    pt.steps[chId] = r ?? steps;
  });
}

export function fillEach(patternId: ID, chId: ID, every: number) {
  editSteps(patternId, chId, (s) => s.map((_, i) => (i % every === 0 ? 1 : 0)));
}

export function shiftSteps(patternId: ID, chId: ID, dir: number) {
  editSteps(patternId, chId, (s) => s.map((_, i) => s[(i - dir + s.length) % s.length]));
}

export function randomizeSteps(patternId: ID, chId: ID, density = 0.3) {
  editSteps(patternId, chId, (s) => s.map(() => (Math.random() < density ? (Math.random() < 0.3 ? 0.6 : 1) : 0)));
}

// ------------------------------------------------------------------ notes
export function setNotes(patternId: ID, chId: ID, notes: Note[], coalesce?: string) {
  up((p) => {
    const pt = p.patterns.find((x) => x.id === patternId);
    if (!pt) return;
    pt.notes[chId] = notes;
    // auto-extend the pattern to fit the notes
    const end = notes.reduce((m, n) => Math.max(m, n.start + n.len), 0);
    const bars = Math.ceil(end / ticksPerBar(p) - 1e-9);
    if (bars > pt.bars) {
      pt.bars = Math.min(64, bars);
      const n = pt.bars * stepsPerBar(p);
      for (const k of Object.keys(pt.steps)) pt.steps[k] = Array.from({ length: n }, (_, i) => pt.steps[k][i] ?? 0);
    }
  }, coalesce);
}

/** FL behaviour: opening the piano roll for a step-sequenced channel turns its steps into notes */
export function stepsToNotes(patternId: ID, chId: ID) {
  const s = getState();
  const pt = s.project.patterns.find((x) => x.id === patternId);
  const ch = s.project.channels.find((c) => c.id === chId);
  if (!pt || !ch) return;
  if ((pt.notes[chId]?.length ?? 0) > 0) return;
  const steps = pt.steps[chId] ?? [];
  if (!steps.some((v) => v > 0)) return;
  const notes: Note[] = [];
  steps.forEach((v, i) => {
    if (v > 0) notes.push({ id: uid('n'), key: ch.rootNote, start: i * TICKS_PER_STEP, len: TICKS_PER_STEP, vel: v });
  });
  up((p) => {
    const q = p.patterns.find((x) => x.id === patternId)!;
    q.notes[chId] = notes;
    q.steps[chId] = (q.steps[chId] ?? []).map(() => 0);
  });
}

export function clearChannelInPattern(patternId: ID, chId: ID) {
  up((p) => {
    const pt = p.patterns.find((x) => x.id === patternId);
    if (!pt) return;
    delete pt.notes[chId];
    delete pt.steps[chId];
  });
}

export function setCodeEnabled(patternId: ID, chId: ID, on: boolean) {
  up((p) => {
    const pt = p.patterns.find((x) => x.id === patternId);
    if (pt) pt.code[chId] = on;
  });
}

// ------------------------------------------------------------------ playlist
export function addClip(init: Omit<Clip, 'id'>) {
  const c = createClip(init);
  up((p) => {
    p.clips.push(c);
  });
  return c.id;
}

export function updateClips(fn: (clips: Clip[], p: Project) => void, coalesce?: string) {
  up((p) => fn(p.clips, p), coalesce);
}

export function deleteClips(ids: ID[]) {
  const set = new Set(ids);
  up((p) => {
    p.clips = p.clips.filter((c) => !set.has(c.id));
  });
  fixSelection();
}

export function makeClipUnique(clipId: ID) {
  const s = getState();
  const clip = s.project.clips.find((c) => c.id === clipId);
  if (!clip?.patternId) return;
  const newId = clonePattern(clip.patternId);
  if (!newId) return;
  up((p) => {
    const c = p.clips.find((x) => x.id === clipId);
    if (c) c.patternId = newId;
  });
}

export function addAutomationClip(chId: ID, param: string, start: number, track: number, length = 4) {
  const s = getState();
  const ch = s.project.channels.find((c) => c.id === chId);
  const id = addClip({
    kind: 'automation',
    track,
    start,
    length,
    automation: {
      name: `${ch?.name ?? 'Channel'} ${param.replace('plugin:', '')}`,
      target: { channelId: chId, param },
      points: [ { x: 0, y: 0.2 }, { x: 1, y: 0.8 } ],
    },
  });
  useStudio.setState({ automationClipId: id });
  getState().openWindow('automation');
  return id;
}

// ------------------------------------------------------------------ mixer
export function setInsert(i: number, patch: Partial<Project['mixer'][number]>, coalesce?: string) {
  up((p) => {
    if (p.mixer[i]) Object.assign(p.mixer[i], patch);
  }, coalesce);
}

const FX_DEFAULT_MIX: Record<string, number> = { chorus: 0.5, space: 0.3, pingpong: 0.3 };

export function addFx(i: number, pluginId: string) {
  if (!EFFECT_MAP[pluginId]) return;
  up((p) => {
    const ins = p.mixer[i];
    if (!ins || ins.fx.length >= 8) return;
    const slot = createFxSlot(pluginId);
    slot.mix = FX_DEFAULT_MIX[pluginId] ?? 1;
    ins.fx.push(slot);
  });
}

export function removeFx(i: number, slotId: ID) {
  up((p) => {
    const ins = p.mixer[i];
    if (ins) ins.fx = ins.fx.filter((f) => f.id !== slotId);
  });
}

export function moveFx(i: number, slotId: ID, dir: -1 | 1) {
  up((p) => {
    const fx = p.mixer[i]?.fx;
    if (!fx) return;
    const a = fx.findIndex((f) => f.id === slotId);
    const b = a + dir;
    if (a < 0 || b < 0 || b >= fx.length) return;
    [fx[a], fx[b]] = [fx[b], fx[a]];
  });
}

export function setFx(i: number, slotId: ID, patch: { enabled?: boolean; mix?: number; param?: [string, number | undefined] }) {
  up(
    (p) => {
      const f = p.mixer[i]?.fx.find((x) => x.id === slotId);
      if (!f) return;
      if (patch.enabled !== undefined) f.enabled = patch.enabled;
      if (patch.mix !== undefined) f.mix = patch.mix;
      if (patch.param) {
        const [k, v] = patch.param;
        if (v === undefined) delete f.params[k];
        else f.params[k] = v;
      }
    },
    `fx:${slotId}:${patch.param?.[0] ?? (patch.mix !== undefined ? 'mix' : 'x')}`,
  );
}

// ------------------------------------------------------------------ project
export function setBpm(bpm: number) {
  bpm = Math.max(20, Math.min(400, Math.round(bpm * 100) / 100));
  up((p) => {
    p.bpm = bpm;
  }, 'bpm');
}

export function setProjectField<K extends keyof Project>(k: K, v: Project[K], coalesce?: string) {
  up((p) => {
    (p as Project)[k] = v;
  }, coalesce ?? `proj:${String(k)}`);
}

// ------------------------------------------------------------------ VST3 channels (native app)
export interface VstPluginRef {
  id: string;
  name: string;
  vendor?: string;
}

export function addVstChannel(plugin: VstPluginRef): ID {
  const id = addChannel({ kind: 'vst', name: plugin.name, sound: '', vst: { pluginId: plugin.id, name: plugin.name, vendor: plugin.vendor, fx: [] } });
  return id;
}

/** turns a channel into a VST3 channel or swaps its instrument */
export function setVstInstrument(chId: ID, plugin: VstPluginRef) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === chId);
    if (!ch) return;
    const wasDefaultName = !ch.vst || ch.name === ch.vst.name || ch.name === ch.sound || ch.name === prettySoundName(ch.sound);
    ch.kind = 'vst';
    ch.vst = { pluginId: plugin.id, name: plugin.name, vendor: plugin.vendor, fx: ch.vst?.fx ?? [] };
    if (wasDefaultName) ch.name = plugin.name;
  });
}

export function addVstFx(chId: ID, plugin: VstPluginRef) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === chId);
    if (!ch?.vst) return;
    ch.vst.fx.push({ id: uid('vfx'), pluginId: plugin.id, name: plugin.name, bypass: false });
  });
}

export function removeVstFx(chId: ID, slotId: ID) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === chId);
    if (!ch?.vst) return;
    ch.vst.fx = ch.vst.fx.filter((f) => f.id !== slotId);
  });
}

export function moveVstFx(chId: ID, slotId: ID, delta: number) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === chId);
    if (!ch?.vst) return;
    const i = ch.vst.fx.findIndex((f) => f.id === slotId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ch.vst.fx.length) return;
    const [x] = ch.vst.fx.splice(i, 1);
    ch.vst.fx.splice(j, 0, x);
  });
}

export function setVstFxBypass(chId: ID, slotId: ID, bypass: boolean) {
  up((p) => {
    const ch = p.channels.find((c) => c.id === chId);
    const f = ch?.vst?.fx.find((x) => x.id === slotId);
    if (f) f.bypass = bypass;
  });
}
