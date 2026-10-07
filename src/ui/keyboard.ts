import { getState, useStudio } from '../store/store';
import { togglePlay, stop, setMode } from '../store/transport';
import { engine } from '../engine/engine';
import * as A from '../store/actions';
import { saveProjectFile, saveToBrowser, openProjectFile, loadProjectGuarded } from './fileio';
import { showExportDialog } from './ExportDialog';
import { PPQ, ticksPerBar, TICKS_PER_STEP } from '../model/types';
import { uid } from '../model/util';
import { isNative, liveNote, setNativeMidiHandler } from '../native/nativeStudio';

// FL-style "typing keyboard to piano": two octaves on the computer keyboard
const LOWER = ['z', 's', 'x', 'd', 'c', 'v', 'g', 'b', 'h', 'n', 'j', 'm', ',', 'l', '.', ';', '/'];
const UPPER = ['q', '2', 'w', '3', 'e', 'r', '5', 't', '6', 'y', '7', 'u', 'i', '9', 'o', '0', 'p'];

export const kbState = { octave: 4 };

function keyToMidi(k: string): number | null {
  const base = (kbState.octave + 1) * 12;
  let i = LOWER.indexOf(k);
  if (i >= 0) return base + i;
  i = UPPER.indexOf(k);
  if (i >= 0) return base + 12 + i;
  return null;
}

const held = new Map<number, { tick: number | null; time: number; vel: number; chId: string }>();

/** source 'native-midi': the note came from a MIDI device of the native app, which already
    played it on the selected VST3 channel (only record / preview non-VST channels then) */
export function noteOn(midi: number, vel = 0.85, source: 'ui' | 'native-midi' = 'ui') {
  const s = getState();
  const ch = s.project.channels.find((c) => c.id === s.channelId);
  if (!ch) return;
  if (ch.kind === 'vst' && isNative) {
    if (source !== 'native-midi') liveNote(ch, midi, vel, true);
  } else engine.previewChannel(s.project, ch, midi, vel, 0.4);
  let tick: number | null = null;
  if (s.recording && s.playing && s.mode === 'pattern' && ch.kind !== 'code') {
    const pos = engine.position();
    if (pos !== null) tick = Math.round((pos * ticksPerBar(s.project)) / TICKS_PER_STEP) * TICKS_PER_STEP;
  }
  held.set(midi, { tick, time: performance.now(), vel, chId: ch.id });
}

export function noteOff(midi: number, source: 'ui' | 'native-midi' = 'ui') {
  const h = held.get(midi);
  held.delete(midi);
  if (h && source !== 'native-midi') {
    const hc = getState().project.channels.find((c) => c.id === h.chId);
    if (hc) liveNote(hc, midi, 0, false);
  }
  if (!h || h.tick === null) return;
  const s = getState();
  const pt = s.project.patterns.find((p) => p.id === s.patternId);
  const chId = s.channelId;
  if (!pt || !chId) return;
  const seconds = (performance.now() - h.time) / 1000;
  const ticks = Math.max(TICKS_PER_STEP, Math.round((seconds * (s.project.bpm / 60) * PPQ) / TICKS_PER_STEP) * TICKS_PER_STEP);
  const total = pt.bars * ticksPerBar(s.project);
  const start = h.tick % total;
  const notes = pt.notes[chId] ?? [];
  A.setNotes(pt.id, chId, [...notes, { id: uid('n'), key: midi, start, len: Math.min(ticks, total - start), vel: h.vel }], 'rec');
}

function isEditable(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor');
}

export function installKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    const s = getState();
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (ctrl) {
      if (k === 'z' && !e.shiftKey) return prevent(e, s.undo);
      if (k === 'y' || (k === 'z' && e.shiftKey)) return prevent(e, s.redo);
      if (k === 's' && e.shiftKey) return prevent(e, () => (isNative ? saveProjectFile(true) : saveToBrowser()));
      if (k === 's') return prevent(e, () => saveProjectFile());
      if (k === 'o') return prevent(e, openProjectFile);
      if (k === 'n') return prevent(e, () => loadProjectGuarded(null));
      if (k === 'r') return prevent(e, showExportDialog);
      return;
    }
    switch (e.key) {
      case ' ':
        return prevent(e, togglePlay);
      case 'F1':
        return prevent(e, () => s.toggleWindow('help'));
      case 'F4':
        return prevent(e, () => A.addPattern());
      case 'F5':
        return prevent(e, () => s.toggleWindow('playlist'));
      case 'F6':
        return prevent(e, () => s.toggleWindow('channelRack'));
      case 'F7':
        return prevent(e, () => s.toggleWindow('pianoRoll'));
      case 'F8':
        return prevent(e, () => s.toggleWindow('pluginLab'));
      case 'F9':
        return prevent(e, () => s.toggleWindow('mixer'));
      case 'F10':
        return prevent(e, () => s.toggleWindow('code'));
      case 'Escape':
        return stop();
    }
    if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
      const i = s.project.patterns.findIndex((p) => p.id === s.patternId);
      const n = s.project.patterns.length;
      const d = e.code === 'NumpadAdd' ? 1 : -1;
      return prevent(e, () => A.selectPattern(s.project.patterns[(i + d + n) % n].id));
    }
    if (e.altKey) return;
    if (k === 'l' && !s.typingKeyboard) return prevent(e, () => setMode(s.mode === 'pattern' ? 'song' : 'pattern'));
    if (s.typingKeyboard) {
      if (k === '-' || k === '=') {
        kbState.octave = Math.max(0, Math.min(8, kbState.octave + (k === '=' ? 1 : -1)));
        s.setHint(`Typing keyboard octave: C${kbState.octave}`);
        useStudio.setState({ hint: `Typing keyboard octave: C${kbState.octave}` });
        return;
      }
      const m = keyToMidi(k);
      if (m !== null) {
        e.preventDefault();
        if (e.repeat) return;
        noteOn(m, e.shiftKey ? 1 : 0.8);
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    const m = keyToMidi(e.key.toLowerCase());
    if (m !== null) noteOff(m);
  });
}

function prevent(e: KeyboardEvent, fn: () => void) {
  e.preventDefault();
  fn();
}

// ---------------------------------------------------------------- MIDI
// native app: MIDI devices are opened by the app (always on) and forwarded here
setNativeMidiHandler((e) => {
  if (e.type === 'on' && e.value > 0) noteOn(e.note, e.value, 'native-midi');
  else if (e.type === 'off' || (e.type === 'on' && e.value === 0)) noteOff(e.note, 'native-midi');
});

let midiAccess: MIDIAccess | null = null;
export async function enableMidi(): Promise<string> {
  if (!('requestMIDIAccess' in navigator)) throw new Error('Web MIDI is not supported in this browser (use Chrome or Edge)');
  midiAccess = await navigator.requestMIDIAccess();
  const attach = () => {
    midiAccess!.inputs.forEach((input) => {
      input.onmidimessage = (msg) => {
        const d = msg.data;
        if (!d || d.length < 3) return;
        const cmd = d[0] & 0xf0;
        if (cmd === 0x90 && d[2] > 0) noteOn(d[1], d[2] / 127);
        else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) noteOff(d[1]);
      };
    });
  };
  attach();
  midiAccess.onstatechange = attach;
  const names = [...midiAccess.inputs.values()].map((i) => i.name).filter(Boolean);
  return names.length ? names.join(', ') : 'no MIDI inputs found (plug one in, it will be picked up)';
}
