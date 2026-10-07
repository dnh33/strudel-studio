import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { compileProject, type CompileResult } from '../model/compile';
import type { PlayMode, Project } from '../model/types';
import { engine } from '../engine/engine';
import { getPluginInfo, getInstalledPlugins, onPluginsChanged } from '../plugins/registry';
import { getState, useStudio, type StudioState } from './store';

// names that generated identifiers must not shadow
export const SCOPE_NAMES = new Set<string>([core, mini, tonal, webaudio].flatMap((m) => Object.keys(m)));

let memo: { key: unknown[]; res: CompileResult }[] = [];
let pluginVersion = 0;
onPluginsChanged(() => {
  pluginVersion++;
  memo = [];
});

export function compileFor(
  project: Project,
  mode: PlayMode,
  patternId: string,
  codeErrors: Record<string, string>,
  forExport = false,
  liveRun: string | null = null,
): CompileResult {
  const metronome = !forExport && useStudio.getState().metronome;
  const key = [project, mode, patternId, codeErrors, forExport, pluginVersion, liveRun, metronome];
  const hit = memo.find((m) => m.key.every((k, i) => k === key[i]));
  if (hit) return hit.res;
  if (mode === 'live' && liveRun !== null) project = { ...project, liveCode: liveRun };
  const res = compileProject(project, {
    mode,
    patternId,
    forExport,
    getPlugin: getPluginInfo,
    invalidCodeChannels: new Set(Object.keys(codeErrors)),
    reservedNames: SCOPE_NAMES,
    allPluginIds: getInstalledPlugins().map((p) => p.id),
  });
  if (metronome) {
    const ticks = ['c6', ...Array(Math.max(0, project.beatsPerBar - 1)).fill('c5')].join(' ');
    res.code += `\n// metronome (not exported)\nmetronome: note("${ticks}").s("sine").decay(.04).sustain(0).gain(.5).orbit(0).color("#ffffff")\n`;
  }
  memo = [{ key, res }, ...memo].slice(0, 6);
  return res;
}

export function compileCurrent(s: Pick<StudioState, 'project' | 'mode' | 'patternId' | 'codeErrors' | 'liveRun'> = getState(), forExport = false) {
  return compileFor(s.project, s.mode, s.patternId, s.codeErrors, forExport, s.liveRun);
}

/** Ctrl+Enter in the live editor: evaluate exactly this code now */
export async function runLiveCode(code: string) {
  useStudio.setState({ mode: 'live', liveRun: code });
  const s = getState();
  if (s.playing) {
    const res = compileCurrent(s);
    engine.setTransport(transportFor(s, res));
    await engine.update(res.code, true);
  } else {
    await play();
  }
}

function transportFor(s: StudioState, res: CompileResult) {
  const pt = s.project.patterns.find((p) => p.id === s.patternId);
  return {
    mode: s.mode,
    startBar: s.mode === 'song' ? s.startBar : 0,
    loop: s.mode === 'song' ? s.loop : null,
    patternBars: pt?.bars ?? 1,
    songBars: res.songBars,
  };
}

export async function play() {
  const s = getState();
  const res = compileCurrent(s);
  try {
    await engine.play(res.code, transportFor(s, res));
  } catch (e) {
    getState().log(String((e as Error)?.message ?? e), 'error');
  }
}

export function stop() {
  engine.stop();
  useStudio.setState({ playing: false });
}

export function togglePlay() {
  if (getState().playing) stop();
  else play();
}

export function setMode(mode: PlayMode) {
  useStudio.setState({ mode });
}

// -------------------------------------------------------------- live sync
let timer: ReturnType<typeof setTimeout> | null = null;
let lastMode: PlayMode | null = null;

function scheduleSync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(syncNow, 40);
}

async function syncNow() {
  timer = null;
  const s = getState();
  const res = compileCurrent(s);
  engine.setTransport(transportFor(s, res));
  if (s.playing) {
    await engine.update(res.code);
    if (lastMode !== null && lastMode !== s.mode) await engine.restart();
  }
  lastMode = s.mode;
}

export function startSync() {
  engine.setProject(getState().project);
  useStudio.subscribe((s, prev) => {
    if (s.project !== prev.project) engine.setProject(s.project);
    if (
      s.project !== prev.project ||
      s.mode !== prev.mode ||
      s.patternId !== prev.patternId ||
      s.codeErrors !== prev.codeErrors ||
      s.loop !== prev.loop ||
      s.startBar !== prev.startBar ||
      s.liveRun !== prev.liveRun ||
      s.metronome !== prev.metronome
    ) {
      scheduleSync();
    }
    // validate code channels when their code changes
    if (s.project.channels !== prev.project.channels) validateCodeChannels(s.project, prev.project);
  });
  onPluginsChanged(scheduleSync);
  engine.on((e) => {
    const st = getState();
    if (e.type === 'playing') useStudio.setState({ playing: e.playing });
    else if (e.type === 'status') useStudio.setState({ engineStatus: e.status, engineMessage: e.message ?? '' });
    else if (e.type === 'error') {
      useStudio.setState({ evalError: e.message });
      if (e.message) st.log(e.message, 'error');
    } else if (e.type === 'log') {
      if (e.level !== 'info' || /\[sampler\] load/.test(e.message) === false) st.log(e.message, e.level);
      if (/load sound|loading|\[sampler\] load/.test(e.message)) useStudio.setState({ engineMessage: e.message });
    }
  });
  validateCodeChannels(getState().project, null);
}

const validated = new Map<string, string>(); // chId -> code last validated
async function validateCodeChannels(p: Project, prev: Project | null) {
  for (const ch of p.channels) {
    if (ch.kind !== 'code') continue;
    const before = prev?.channels.find((c) => c.id === ch.id);
    if (before && before.code === ch.code && validated.get(ch.id) === ch.code) continue;
    validated.set(ch.id, ch.code);
    const code = ch.code;
    const err = await engine.validateSnippet(code);
    if (validated.get(ch.id) !== code) continue; // stale
    const cur = getState().codeErrors;
    if (err && cur[ch.id] !== err) useStudio.setState({ codeErrors: { ...cur, [ch.id]: err } });
    else if (!err && cur[ch.id]) {
      const next = { ...cur };
      delete next[ch.id];
      useStudio.setState({ codeErrors: next });
    }
  }
}

/**
 * playhead position (in bars) inside the selected pattern: in pattern mode the loop position,
 * in song mode the position inside the playlist clip of that pattern that is currently playing.
 */
export function patternPlayhead(): number | null {
  const s = getState();
  const pos = engine.position();
  if (pos === null) return null;
  const pt = s.project.patterns.find((p) => p.id === s.patternId);
  if (!pt) return null;
  if (s.mode === 'pattern') return pos % pt.bars;
  if (s.mode !== 'song') return null;
  const clip = s.project.clips.find(
    (c) => c.kind === 'pattern' && c.patternId === pt.id && !s.project.tracks[c.track]?.mute && pos >= c.start && pos < c.start + c.length,
  );
  return clip ? (pos - clip.start) % pt.bars : null;
}

/** seek: set start marker and restart playback there (song mode) */
export async function seek(bar: number) {
  useStudio.setState({ startBar: Math.max(0, bar) });
  const s = getState();
  if (s.playing && s.mode === 'song') {
    const res = compileCurrent(s);
    engine.setTransport(transportFor(s, res));
    await engine.restart();
  }
}
