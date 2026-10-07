import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { ID, PlayMode, Project } from '../model/types';
import { createEmptyProject } from '../model/factory';
import { createHouseDemo } from '../model/demos';
import { migrateProject } from './migrate';

export type WindowId = 'playlist' | 'channelRack' | 'pianoRoll' | 'mixer' | 'code' | 'channelSettings' | 'automation' | 'pluginLab' | 'help';

export interface WinState {
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  max?: boolean;
}

export const WINDOW_TITLES: Record<WindowId, string> = {
  playlist: 'Playlist',
  channelRack: 'Channel Rack',
  pianoRoll: 'Piano Roll',
  mixer: 'Mixer',
  code: 'Strudel Code',
  channelSettings: 'Channel Settings',
  automation: 'Automation Clip',
  pluginLab: 'Plugin Lab',
  help: 'Help & Shortcuts',
};

export function defaultWindows(): Record<WindowId, WinState> {
  const W = typeof window !== 'undefined' ? window.innerWidth - 260 : 1600;
  const H = typeof window !== 'undefined' ? window.innerHeight - 90 : 900;
  const half = Math.round(W * 0.52);
  return {
    playlist: { open: true, x: 8, y: 8, w: W - 16, h: Math.round(H * 0.44), z: 1 },
    channelRack: { open: true, x: 8, y: Math.round(H * 0.44) + 16, w: half, h: Math.round(H * 0.56) - 24, z: 2 },
    pianoRoll: { open: false, x: 60, y: 60, w: Math.min(1100, W - 120), h: Math.min(560, H - 100), z: 3 },
    mixer: { open: false, x: 40, y: Math.round(H * 0.34), w: Math.min(1200, W - 80), h: Math.min(460, H - 60), z: 4 },
    code: { open: true, x: half + 16, y: Math.round(H * 0.44) + 16, w: W - half - 24, h: Math.round(H * 0.56) - 24, z: 5 },
    channelSettings: { open: false, x: 140, y: 80, w: 640, h: 520, z: 6 },
    automation: { open: false, x: 180, y: 120, w: 720, h: 360, z: 7 },
    pluginLab: { open: false, x: 100, y: 40, w: Math.min(1100, W - 120), h: Math.min(700, H - 60), z: 8 },
    help: { open: false, x: 160, y: 40, w: 760, h: Math.min(720, H - 60), z: 9 },
  };
}

export interface LogEntry {
  time: number;
  message: string;
  level: 'info' | 'warning' | 'error';
}

export interface StudioState {
  project: Project;
  past: Project[];
  future: Project[];
  lastCoalesce: { key: string; time: number } | null;
  dirty: boolean;
  fileName: string | null;

  // transport
  mode: PlayMode;
  playing: boolean;
  startBar: number;
  loop: { start: number; end: number } | null;
  recording: boolean;
  /** live code as of the last Ctrl+Enter (what is actually playing in live mode) */
  liveRun: string | null;

  // selection
  patternId: ID;
  channelId: ID | null; // selected channel (piano roll target)
  settingsChannelId: ID | null;
  automationClipId: ID | null;
  selectedInsert: number;
  selectedChannels: ID[];

  // windows
  windows: Record<WindowId, WinState>;
  zTop: number;

  // engine
  engineStatus: 'idle' | 'loading' | 'ready' | 'failed';
  engineMessage: string;
  evalError: string | null;
  codeErrors: Record<ID, string>;
  logs: LogEntry[];
  hint: string;
  typingKeyboard: boolean;
  metronome: boolean;
  follow: boolean;

  // actions
  update: (fn: (d: Draft<Project>) => void, coalesce?: string) => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project, fileName?: string | null) => void;
  set: (partial: Partial<StudioState>) => void;
  openWindow: (id: WindowId, open?: boolean) => void;
  toggleWindow: (id: WindowId) => void;
  focusWindow: (id: WindowId) => void;
  moveWindow: (id: WindowId, patch: Partial<WinState>) => void;
  resetLayout: () => void;
  setHint: (h: string) => void;
  log: (message: string, level?: LogEntry['level']) => void;
}

const WIN_KEY = 'strudel-studio:windows';
const AUTOSAVE_KEY = 'strudel-studio:autosave';

function loadWindows(): Record<WindowId, WinState> {
  const d = defaultWindows();
  try {
    const raw = localStorage.getItem(WIN_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(d) as WindowId[]) if (saved[k]) d[k] = { ...d[k], ...saved[k] };
    }
  } catch {
    /* ignore */
  }
  return d;
}

function initialProject(): { project: Project; restored: boolean } {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return { project: migrateProject(JSON.parse(raw)), restored: true };
  } catch (e) {
    console.warn('autosave could not be restored', e);
  }
  try {
    return { project: createHouseDemo(), restored: false };
  } catch {
    return { project: createEmptyProject(), restored: false };
  }
}

const init = initialProject();
const HISTORY = 200;

export const useStudio = create<StudioState>((set, get) => ({
  project: init.project,
  past: [],
  future: [],
  lastCoalesce: null,
  dirty: false,
  fileName: null,

  mode: 'pattern',
  playing: false,
  startBar: 0,
  loop: null,
  recording: false,
  liveRun: null,

  patternId: init.project.patterns[0]?.id ?? '',
  channelId: init.project.channels[0]?.id ?? null,
  settingsChannelId: null,
  automationClipId: null,
  selectedInsert: 1,
  selectedChannels: [],

  windows: loadWindows(),
  zTop: 20,

  engineStatus: 'idle',
  engineMessage: 'Click anywhere to start the audio engine',
  evalError: null,
  codeErrors: {},
  logs: [],
  hint: '',
  typingKeyboard: true,
  metronome: false,
  follow: true,

  update: (fn, coalesce) => {
    const s = get();
    const next = produce(s.project, (d) => {
      fn(d);
    });
    if (next === s.project) return;
    const now = Date.now();
    const merge = coalesce && s.lastCoalesce && s.lastCoalesce.key === coalesce && now - s.lastCoalesce.time < 1200;
    const past = merge ? s.past : [...s.past.slice(-HISTORY + 1), s.project];
    set({
      project: { ...next, updatedAt: now },
      past,
      future: [],
      dirty: true,
      lastCoalesce: coalesce ? { key: coalesce, time: now } : null,
    });
  },
  undo: () => {
    const s = get();
    if (!s.past.length) return;
    const prev = s.past[s.past.length - 1];
    set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], lastCoalesce: null, dirty: true });
    fixSelection();
  },
  redo: () => {
    const s = get();
    if (!s.future.length) return;
    const next = s.future[0];
    set({ project: next, future: s.future.slice(1), past: [...s.past, s.project], lastCoalesce: null, dirty: true });
    fixSelection();
  },
  loadProject: (p, fileName = null) => {
    const project = migrateProject(p);
    set({
      project,
      past: [],
      future: [],
      dirty: false,
      fileName,
      patternId: project.patterns[0]?.id ?? '',
      channelId: project.channels[0]?.id ?? null,
      settingsChannelId: null,
      automationClipId: null,
      startBar: 0,
      loop: null,
      codeErrors: {},
    });
  },
  set: (partial) => set(partial),
  openWindow: (id, open = true) => {
    const s = get();
    const z = s.zTop + 1;
    set({ windows: { ...s.windows, [id]: { ...s.windows[id], open, z } }, zTop: z });
    saveWindows();
  },
  toggleWindow: (id) => {
    const s = get();
    const w = s.windows[id];
    const top = w.z === s.zTop;
    // like FL: F-keys bring a window to front, or close it if it is already on top
    if (w.open && top) get().openWindow(id, false);
    else get().openWindow(id, true);
  },
  focusWindow: (id) => {
    const s = get();
    if (s.windows[id].z === s.zTop) return;
    const z = s.zTop + 1;
    set({ windows: { ...s.windows, [id]: { ...s.windows[id], z } }, zTop: z });
  },
  moveWindow: (id, patch) => {
    const s = get();
    set({ windows: { ...s.windows, [id]: { ...s.windows[id], ...patch } } });
    saveWindows();
  },
  resetLayout: () => {
    set({ windows: defaultWindows(), zTop: 20 });
    saveWindows();
  },
  setHint: (h) => {
    if (get().hint !== h) set({ hint: h });
  },
  log: (message, level = 'info') => {
    const logs = [...get().logs.slice(-199), { time: Date.now(), message, level }];
    set({ logs });
  },
}));

let winTimer: ReturnType<typeof setTimeout> | null = null;
function saveWindows() {
  if (winTimer) clearTimeout(winTimer);
  winTimer = setTimeout(() => {
    try {
      localStorage.setItem(WIN_KEY, JSON.stringify(useStudio.getState().windows));
    } catch {
      /* ignore */
    }
  }, 300);
}

/** keep selected ids valid after undo/redo/deletes */
export function fixSelection() {
  const s = useStudio.getState();
  const p = s.project;
  const patch: Partial<StudioState> = {};
  if (!p.patterns.some((x) => x.id === s.patternId)) patch.patternId = p.patterns[0]?.id ?? '';
  if (s.channelId && !p.channels.some((c) => c.id === s.channelId)) patch.channelId = p.channels[0]?.id ?? null;
  if (s.settingsChannelId && !p.channels.some((c) => c.id === s.settingsChannelId)) patch.settingsChannelId = null;
  if (s.automationClipId && !p.clips.some((c) => c.id === s.automationClipId)) patch.automationClipId = null;
  if (Object.keys(patch).length) useStudio.setState(patch);
}

// autosave
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStudio.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(useStudio.getState().project));
    } catch (e) {
      console.warn('autosave failed', e);
    }
  }, 800);
});

export const useProject = () => useStudio((s) => s.project);
export const getState = () => useStudio.getState();
export const restoredFromAutosave = init.restored;
