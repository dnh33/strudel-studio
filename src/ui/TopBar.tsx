import { useRef, useState } from 'react';
import { useStudio, getState, type WindowId } from '../store/store';
import { togglePlay, stop, setMode } from '../store/transport';
import * as A from '../store/actions';
import { Knob } from './components/Knob';
import { Scope } from './components/Meter';
import { openMenuAt, promptText, type MenuItem } from './components/Menu';
import { PatternPicker } from './windows/PatternPicker';
import { engine } from '../engine/engine';
import { useTick } from './ticker';
import { saveProjectFile, saveToBrowser, openProjectFile, loadProjectGuarded, exportMidi, copyText, openInStrudel } from './fileio';
import { showExportDialog } from './ExportDialog';
import { DEMOS } from '../model/demos';
import { enableMidi, kbState } from './keyboard';
import { compileCurrent } from '../store/transport';
import { isNative, native } from '../native/bridge';
import { useNative, scanPlugins, setSyncOffset, setExtraFolders, nativeMeters } from '../native/nativeStudio';
import {
  IconPlay, IconPause, IconStop, IconRecord, IconPlaylist, IconRack, IconPiano, IconMixer, IconCode, IconPlug, IconHelp, IconUndo, IconRedo, IconKeyboard, IconMidi, IconMetronome,
} from './components/Icons';

function fileMenu(): MenuItem[] {
  return [
    { label: 'New project', shortcut: 'Ctrl+N', onClick: () => loadProjectGuarded(null) },
    { label: 'Open project file…', shortcut: 'Ctrl+O', onClick: openProjectFile },
    { label: 'Open demo', submenu: DEMOS.map((d) => ({ label: d.name, onClick: () => loadProjectGuarded(d.make()) })) },
    { separator: true },
    { label: isNative ? 'Save project' : 'Save project file (.json)', shortcut: 'Ctrl+S', onClick: () => saveProjectFile() },
    ...(isNative
      ? [
          { label: 'Save project as…', shortcut: 'Ctrl+Shift+S', onClick: () => saveProjectFile(true) },
          { label: 'Save to app storage', onClick: () => saveToBrowser() },
        ]
      : [{ label: 'Save to browser storage', shortcut: 'Ctrl+Shift+S', onClick: () => saveToBrowser() }]),
    { separator: true },
    { label: 'Export audio / stems / MIDI…', shortcut: 'Ctrl+R', onClick: showExportDialog },
    { label: 'Export MIDI file', onClick: exportMidi },
    { label: 'Copy Strudel code', onClick: () => copyText(compileCurrent(getState(), true).code) },
    { label: 'Open in strudel.cc ↗', onClick: () => openInStrudel(compileCurrent(getState(), true).code) },
    { separator: true },
    { label: 'Project info…', onClick: () => promptText('Project name', getState().project.name, (v) => v && A.setProjectField('name', v)) },
  ];
}

function audioMenu(): MenuItem[] {
  const n = useNative.getState();
  return [
    { label: 'Audio & MIDI settings…', onClick: () => native.audioSettings() },
    { separator: true },
    { label: n.scanning ? 'Scanning VST3 plug-ins…' : 'Scan for new VST3 plug-ins', disabled: n.scanning, onClick: () => scanPlugins(false) },
    { label: 'Rescan all VST3 plug-ins', disabled: n.scanning, onClick: () => scanPlugins(true) },
    {
      label: 'VST3 folders…',
      onClick: () =>
        promptText(
          `Extra VST3 folders (separated by ;). Always scanned: ${(n.hello?.defaultPluginFolders ?? []).join(' ; ') || 'the default VST3 folder'}`,
          n.extraFolders.join(';'),
          (v) => setExtraFolders(v.split(';').map((x) => x.trim()).filter(Boolean)),
        ),
    },
    { separator: true },
    {
      label: `VST3 timing offset… (${n.syncOffsetMs.toFixed(0)} ms)`,
      onClick: () =>
        promptText('Delay VST3 channels by (ms, can be negative) to line them up with the Strudel sounds', String(n.syncOffsetMs), (v) => {
          const x = parseFloat(v);
          if (isFinite(x)) setSyncOffset(x);
        }),
    },
    { label: 'Panic (all VST3 notes off)', onClick: () => native.panic() },
  ];
}

function NativeStatus() {
  const audio = useNative((s) => s.audio);
  const ref = useRef<HTMLSpanElement>(null);
  useTick(() => {
    const el = ref.current;
    if (!el) return;
    const cpu = nativeMeters.data && performance.now() - nativeMeters.time < 2000 ? nativeMeters.data.cpu : 0;
    const txt = `${Math.round(cpu * 100)}%`;
    if (el.textContent !== txt) el.textContent = txt;
  });
  if (!audio) return null;
  const latency = audio.sampleRate ? ((audio.bufferSize / audio.sampleRate) * 1000).toFixed(1) : '?';
  return (
    <button
      className="native-status"
      onClick={() => native.audioSettings()}
      title={`Native audio: ${audio.type} · ${audio.device || 'no device'} · ${audio.sampleRate} Hz · ${audio.bufferSize} samples (${latency} ms)\nMIDI in: ${audio.midiInputs.join(', ') || 'none'}\nClick for audio & MIDI settings`}
    >
      <span className={'dot' + (audio.running ? ' on' : '')} />
      {audio.type.replace('Windows Audio', 'WASAPI')} · {latency} ms · CPU <span ref={ref}>0%</span>
    </button>
  );
}

function editMenu(): MenuItem[] {
  const s = getState();
  return [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !s.past.length, onClick: s.undo },
    { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !s.future.length, onClick: s.redo },
    { separator: true },
    { label: 'New pattern', shortcut: 'F4', onClick: () => A.addPattern() },
    { label: 'Clone pattern', onClick: () => A.clonePattern(s.patternId) },
    { separator: true },
    {
      label: 'Time signature',
      submenu: [2, 3, 4, 5, 6, 7].map((n) => ({ label: `${n}/4`, checked: s.project.beatsPerBar === n, onClick: () => A.setProjectField('beatsPerBar', n) })),
    },
  ];
}

function viewMenu(): MenuItem[] {
  const s = getState();
  const w = (id: WindowId, label: string, key: string): MenuItem => ({ label, shortcut: key, checked: s.windows[id].open, onClick: () => s.toggleWindow(id) });
  return [
    w('playlist', 'Playlist', 'F5'),
    w('channelRack', 'Channel rack', 'F6'),
    w('pianoRoll', 'Piano roll', 'F7'),
    w('pluginLab', 'Plugin Lab', 'F8'),
    w('mixer', 'Mixer', 'F9'),
    w('code', 'Strudel code', 'F10'),
    w('channelSettings', 'Channel settings', ''),
    w('automation', 'Automation clip', ''),
    { separator: true },
    { label: 'Reset window layout', onClick: s.resetLayout },
  ];
}

function helpMenu(): MenuItem[] {
  return [
    { label: 'Help & shortcuts', shortcut: 'F1', onClick: () => getState().openWindow('help') },
    { label: 'Strudel documentation ↗', onClick: () => window.open('https://strudel.cc/workshop/getting-started/', '_blank') },
    ...(isNative ? [{ label: 'Open app data folder', onClick: () => { const f = useNative.getState().hello?.dataFolder; if (f) native.showInFolder(f); } }] : []),
    { label: 'Strudel function reference ↗', onClick: () => window.open('https://strudel.cc/functions/intro/', '_blank') },
  ];
}

function NativeMidiButton() {
  const inputs = useNative((s) => s.audio?.midiInputs ?? []);
  return (
    <button
      className={'icon-btn' + (inputs.length ? ' on' : '')}
      onClick={() => native.audioSettings()}
      title={inputs.length ? `MIDI input (native): ${inputs.join(', ')} — plays the selected channel` : 'No MIDI input device found — plug one in (click for audio & MIDI settings)'}
    >
      <IconMidi />
    </button>
  );
}

function Bpm() {
  const bpm = useStudio((s) => s.project.bpm);
  const drag = useRef<{ y: number; v: number } | null>(null);
  return (
    <div
      className="bpm"
      title="Tempo — drag up/down (Shift = fine), wheel, double-click to type"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: bpm };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const d = (drag.current.y - e.clientY) * (e.shiftKey ? 0.05 : 0.5);
        A.setBpm(Math.round((drag.current.v + d) * (e.shiftKey ? 100 : 1)) / (e.shiftKey ? 100 : 1));
      }}
      onPointerUp={() => (drag.current = null)}
      onWheel={(e) => A.setBpm(bpm + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 1))}
      onDoubleClick={() => promptText('Tempo (BPM)', String(bpm), (v) => +v > 0 && A.setBpm(+v))}
    >
      <span className="bpm-val">{bpm.toFixed(bpm % 1 ? 2 : 0)}</span>
      <span className="bpm-unit">BPM</span>
    </div>
  );
}

const taps: number[] = [];
function TapTempo() {
  return (
    <button
      className="tap-btn"
      title="Tap tempo — click in time with the beat"
      onClick={() => {
        const now = performance.now();
        if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
        taps.push(now);
        if (taps.length > 8) taps.shift();
        if (taps.length >= 3) {
          const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
          A.setBpm(Math.round(60000 / d));
        }
      }}
    >
      TAP
    </button>
  );
}

function Position() {
  const ref = useRef<HTMLDivElement>(null);
  const bpb = useStudio((s) => s.project.beatsPerBar);
  useTick(() => {
    const el = ref.current;
    if (!el) return;
    const s = getState();
    const pos = engine.position();
    const p = pos ?? (s.mode === 'song' ? s.startBar : 0);
    const bar = Math.floor(p);
    const beatF = (p - bar) * bpb;
    const beat = Math.floor(beatF);
    const step = Math.floor((beatF - beat) * 4);
    const secs = (p * bpb * 60) / s.project.bpm;
    const txt = `${String(bar + 1).padStart(3, '0')}:${beat + 1}:${String(step + 1).padStart(2, '0')}  ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
    if (el.textContent !== txt) el.textContent = txt;
  });
  return <div className="position" ref={ref} title="Bar : beat : step   time" />;
}

export function TopBar() {
  const playing = useStudio((s) => s.playing);
  const mode = useStudio((s) => s.mode);
  const recording = useStudio((s) => s.recording);
  const windows = useStudio((s) => s.windows);
  const master = useStudio((s) => s.project.mixer[0]?.volume ?? 0.8);
  const typing = useStudio((s) => s.typingKeyboard);
  const metronome = useStudio((s) => s.metronome);
  const name = useStudio((s) => s.project.name);
  const dirty = useStudio((s) => s.dirty);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const [midi, setMidi] = useState<string | null>(null);
  const s = useStudio.getState();

  const winBtn = (id: WindowId, icon: React.ReactNode, title: string) => (
    <button className={'win-toggle' + (windows[id].open ? ' on' : '')} title={title} onClick={() => s.toggleWindow(id)}>
      {icon}
    </button>
  );

  return (
    <header className="topbar">
      <div className="logo" title="Strudel Studio">
        <svg width="22" height="22" viewBox="0 0 64 64">
          <path d="M10 46 L22 18 L32 40 L42 12 L54 46" fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <nav className="menubar">
        <button onClick={(e) => openMenuAt(e.currentTarget, fileMenu())}>File</button>
        <button onClick={(e) => openMenuAt(e.currentTarget, editMenu())}>Edit</button>
        <button onClick={(e) => openMenuAt(e.currentTarget, viewMenu())}>View</button>
        {isNative && <button onClick={(e) => openMenuAt(e.currentTarget, audioMenu())}>Audio</button>}
        <button onClick={(e) => openMenuAt(e.currentTarget, helpMenu())}>Help</button>
      </nav>
      <div className="proj-name" title="Project name (click to rename)" onClick={() => promptText('Project name', name, (v) => v && A.setProjectField('name', v))}>
        {name}
        {dirty ? ' •' : ''}
      </div>
      <div className="group">
        <button className="icon-btn" disabled={!canUndo} onClick={s.undo} title="Undo (Ctrl+Z)">
          <IconUndo />
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={s.redo} title="Redo (Ctrl+Y)">
          <IconRedo />
        </button>
      </div>
      <div className="transport">
        <button className={'tp-btn play' + (playing ? ' on' : '')} onClick={togglePlay} title="Play / stop (Space)">
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="tp-btn" onClick={stop} title="Stop (Esc)">
          <IconStop />
        </button>
        <button className={'tp-btn rec' + (recording ? ' on' : '')} onClick={() => useStudio.setState({ recording: !recording })} title="Record notes from the typing keyboard / MIDI into the piano roll (pattern mode)">
          <IconRecord />
        </button>
      </div>
      <div className="seg mode" title="Pattern / Song / Live-code mode (L)">
        <button className={mode === 'pattern' ? 'on' : ''} onClick={() => setMode('pattern')}>
          PAT
        </button>
        <button className={mode === 'song' ? 'on' : ''} onClick={() => setMode('song')}>
          SONG
        </button>
        <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>
          LIVE
        </button>
      </div>
      <Bpm />
      <TapTempo />
      <Position />
      <PatternPicker compact />
      <div className="group">
        <Knob size={30} value={master} min={0} max={1.25} def={0.9} label="" format={(v) => `Master ${(20 * Math.log10(Math.max(v, 1e-4))).toFixed(1)} dB`} onChange={(v) => A.setInsert(0, { volume: v }, 'mastervol')} hint="Master volume" />
        <Scope />
      </div>
      <div className="group">
        <button className={'icon-btn' + (metronome ? ' on' : '')} onClick={() => useStudio.setState({ metronome: !metronome })} title="Metronome">
          <IconMetronome />
        </button>
        <button
          className={'icon-btn' + (typing ? ' on' : '')}
          onClick={() => useStudio.setState({ typingKeyboard: !typing })}
          title={`Typing keyboard to piano (Z…M, Q…P rows, -/= octave, now C${kbState.octave}). Plays the selected channel.`}
        >
          <IconKeyboard />
        </button>
        {isNative ? (
          <NativeMidiButton />
        ) : (
        <button
          className={'icon-btn' + (midi ? ' on' : '')}
          onClick={async () => {
            try {
              const names = await enableMidi();
              setMidi(names);
              getState().log('MIDI: ' + names);
              getState().setHint('MIDI input: ' + names);
            } catch (e) {
              getState().log(String((e as Error).message), 'error');
              getState().setHint(String((e as Error).message));
            }
          }}
          title={midi ? `MIDI: ${midi}` : 'Enable MIDI keyboard input'}
        >
          <IconMidi />
        </button>
        )}
      </div>
      {isNative && <NativeStatus />}
      <div className="spacer" />
      <div className="group windows">
        {winBtn('playlist', <IconPlaylist />, 'Playlist (F5)')}
        {winBtn('channelRack', <IconRack />, 'Channel rack (F6)')}
        {winBtn('pianoRoll', <IconPiano />, 'Piano roll (F7)')}
        {winBtn('mixer', <IconMixer />, 'Mixer (F9)')}
        {winBtn('code', <IconCode />, 'Strudel code (F10)')}
        {winBtn('pluginLab', <IconPlug />, 'Plugin Lab (F8)')}
        {winBtn('help', <IconHelp />, 'Help (F1)')}
      </div>
      <button className="tb-btn primary export-btn" onClick={showExportDialog} title="Export WAV / stems / MIDI / code (Ctrl+R)">
        Export
      </button>
    </header>
  );
}
