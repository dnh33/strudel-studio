import { memo, useRef } from 'react';
import { useStudio, getState } from '../../store/store';
import type { Channel, Pattern, Project } from '../../model/types';
import { stepsPerBar, ticksPerBar } from '../../model/types';
import { getSteps } from '../../model/factory';
import * as A from '../../store/actions';
import { Window } from '../components/Window';
import { Knob } from '../components/Knob';
import { openContextMenu, openMenuAt, promptText, type MenuItem } from '../components/Menu';
import { useTick } from '../ticker';
import { engine } from '../../engine/engine';
import { patternPlayhead } from '../../store/transport';
import { PatternPicker } from './PatternPicker';
import { getInstalledPlugins } from '../../plugins/registry';
import { CHANNEL_CORE_AUTOMATION, CHANNEL_PARAMS } from '../../model/paramDefs';
import { PALETTE } from '../../model/util';
import type { LibItem } from '../../engine/library';
import { IconPlus } from '../components/Icons';
import { isNative, useNative } from '../../native/nativeStudio';

const STEP_W = 22;

export function addChannelMenu(): MenuItem[] {
  return [
    { label: 'Sampler (Kick 909)', onClick: () => A.addChannel({ kind: 'sample', name: 'Kick', sound: 'bd', bank: 'RolandTR909' }) },
    {
      label: 'Synth',
      submenu: ['sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'pulse'].map((s) => ({
        label: s,
        onClick: () => A.addChannel({ kind: 'synth', name: s[0].toUpperCase() + s.slice(1), sound: s }),
      })),
    },
    {
      label: 'Plugin instrument',
      submenu: getInstalledPlugins().map((p) => ({
        label: p.name,
        hint: p.description,
        onClick: () => A.addChannel({ kind: 'plugin', name: p.name, sound: p.id }),
      })),
    },
    ...(isNative ? [vstInstrumentMenu((p) => A.addVstChannel(p))] : []),
    { label: 'Soundfont (GM Piano)', onClick: () => A.addChannel({ kind: 'soundfont', name: 'Piano', sound: 'gm_piano' }) },
    { label: 'Code channel (Strudel)', onClick: () => {
      const id = A.addChannel({ kind: 'code', name: 'Code' });
      const s = getState();
      A.setCodeEnabled(s.patternId, id, true);
      useStudio.setState({ settingsChannelId: id });
      s.openWindow('channelSettings');
    } },
    { separator: true },
    { label: 'Tip: drag sounds from the browser onto the rack', disabled: true },
  ];
}

/** "VST3 instrument" submenu grouped by vendor (native app) */
export function vstInstrumentMenu(onPick: (p: { id: string; name: string; vendor?: string }) => void, label = 'VST3 instrument'): MenuItem {
  const list = useNative.getState().plugins.filter((p) => p.isInstrument);
  if (!list.length) return { label: `${label} (none found — scan in the Audio menu)`, disabled: true };
  const vendors = [...new Set(list.map((p) => p.vendor || 'Other'))].sort();
  const item = (p: (typeof list)[number]) => ({ label: p.name, hint: `${p.vendor} · ${p.category}`, onClick: () => onPick(p) });
  return {
    label,
    submenu: vendors.length > 1 && list.length > 12 ? vendors.map((v) => ({ label: v, submenu: list.filter((p) => (p.vendor || 'Other') === v).map(item) })) : list.map(item),
  };
}

export function channelMenu(ch: Channel, pattern: Pattern | undefined, project: Project): MenuItem[] {
  const s = getState();
  const pid = pattern?.id ?? '';
  const autoParams = [
    ...CHANNEL_CORE_AUTOMATION,
    ...CHANNEL_PARAMS.filter((d) => d.automatable && (!d.kinds || d.kinds.includes(ch.kind))),
  ];
  return [
    { label: 'Piano roll', shortcut: 'F7', onClick: () => openPianoRoll(ch.id) },
    { label: 'Channel settings…', onClick: () => openSettings(ch.id) },
    { label: 'Preview', onClick: () => engine.previewChannel(project, ch) },
    { separator: true },
    { label: 'Rename…', onClick: () => promptText('Rename channel', ch.name, (v) => v && A.setChannel(ch.id, { name: v })) },
    { label: 'Color', submenu: PALETTE.map((c) => ({ label: c, color: c, onClick: () => A.setChannel(ch.id, { color: uniqueFor(c, ch.id) }) })) },
    {
      label: 'Route to mixer insert',
      submenu: project.mixer.map((m, i) => ({ label: `${i === 0 ? 'Master' : i + ' · ' + m.name}`, checked: ch.insert === i, onClick: () => A.setChannel(ch.id, { insert: i }) })),
    },
    {
      label: 'Create automation clip',
      submenu: autoParams.map((d) => ({
        label: d.label,
        onClick: () => A.addAutomationClip(ch.id, d.key, getState().startBar, firstFreeTrack(project)),
      })),
    },
    { separator: true },
    { label: 'Fill each 2 steps', disabled: !pid || ch.kind === 'code', onClick: () => A.fillEach(pid, ch.id, 2) },
    { label: 'Fill each 4 steps', disabled: !pid || ch.kind === 'code', onClick: () => A.fillEach(pid, ch.id, 4) },
    { label: 'Fill each 8 steps', disabled: !pid || ch.kind === 'code', onClick: () => A.fillEach(pid, ch.id, 8) },
    { label: 'Randomize', disabled: !pid || ch.kind === 'code', onClick: () => A.randomizeSteps(pid, ch.id) },
    { label: 'Shift right', disabled: !pid, onClick: () => A.shiftSteps(pid, ch.id, 1) },
    { label: 'Shift left', disabled: !pid, onClick: () => A.shiftSteps(pid, ch.id, -1) },
    { label: 'Clear in this pattern', disabled: !pid, onClick: () => A.clearChannelInPattern(pid, ch.id) },
    { separator: true },
    { label: 'Move up', onClick: () => A.moveChannel(ch.id, -1) },
    { label: 'Move down', onClick: () => A.moveChannel(ch.id, 1) },
    { label: 'Clone channel', onClick: () => A.cloneChannel(ch.id) },
    { label: 'Delete channel', danger: true, onClick: () => A.deleteChannel(ch.id) },
    { separator: true },
    { label: 'Mute', checked: ch.mute, onClick: () => A.toggleMute(ch.id) },
    { label: 'Solo', checked: ch.solo, onClick: () => A.toggleSolo(ch.id) },
    { label: s.channelId === ch.id ? 'Selected (piano roll & keyboard target)' : 'Select', checked: s.channelId === ch.id, onClick: () => useStudio.setState({ channelId: ch.id }) },
  ];
}

function uniqueFor(color: string, chId: string) {
  const used = new Set(getState().project.channels.filter((c) => c.id !== chId).map((c) => c.color));
  let c = color;
  let i = 0;
  while (used.has(c) && i < 50) {
    i++;
    c = color.slice(0, 5) + ((parseInt(color.slice(5), 16) + i * 3) % 256).toString(16).padStart(2, '0');
  }
  return c;
}

function firstFreeTrack(p: Project) {
  for (let i = p.tracks.length - 1; i >= 0; i--) if (p.clips.some((c) => c.track === i)) return Math.min(p.tracks.length - 1, i + 1);
  return 0;
}

export function openPianoRoll(chId: string) {
  const s = getState();
  useStudio.setState({ channelId: chId });
  const ch = s.project.channels.find((c) => c.id === chId);
  if (ch?.kind === 'code') {
    openSettings(chId);
    return;
  }
  A.stepsToNotes(s.patternId, chId);
  s.openWindow('pianoRoll');
}

export function openSettings(chId: string) {
  useStudio.setState({ settingsChannelId: chId, channelId: chId });
  getState().openWindow('channelSettings');
}

export function libFromDrag(e: React.DragEvent): LibItem | null {
  try {
    const raw = e.dataTransfer.getData('application/x-studio-lib');
    return raw ? (JSON.parse(raw) as LibItem) : null;
  } catch {
    return null;
  }
}

export function ChannelRack() {
  const project = useStudio((s) => s.project);
  const patternId = useStudio((s) => s.patternId);
  const selected = useStudio((s) => s.channelId);
  const codeErrors = useStudio((s) => s.codeErrors);
  const pattern = project.patterns.find((p) => p.id === patternId);
  const leds = useRef(new Map<string, HTMLElement>());
  const playhead = useRef<HTMLDivElement>(null);
  const spb = stepsPerBar(project);
  const nSteps = (pattern?.bars ?? 1) * spb;

  useTick(() => {
    // activity LEDs
    const trig = engine.recentTriggers(0.12);
    const active = new Set(trig.map((t) => t.color));
    for (const ch of getState().project.channels) {
      const el = leds.current.get(ch.id);
      if (el) el.classList.toggle('on', active.has(ch.color));
    }
    // playhead column
    const ph = playhead.current;
    if (!ph) return;
    const pos = patternPlayhead();
    if (pos === null) {
      ph.style.display = 'none';
      return;
    }
    const step = Math.floor(pos * spb);
    ph.style.display = 'block';
    ph.style.transform = `translateX(${step * STEP_W}px)`;
  });

  const onDrop = (e: React.DragEvent) => {
    const item = libFromDrag(e);
    if (!item) return;
    e.preventDefault();
    A.addChannelFromLibrary(item);
  };

  return (
    <Window
      id="channelRack"
      toolbar={
        <>
          <PatternPicker />
          <label className="tb-label">Swing</label>
          <Knob size={22} value={project.swing} min={0} max={1} def={0} label="" format={(v) => Math.round(v * 100) + '%'} onChange={(v) => A.setProjectField('swing', v, 'swing')} hint="Global swing for step sequenced channels" />
          <button className="tb-btn" title="Add a channel" onClick={(e) => openMenuAt(e.currentTarget, addChannelMenu())}>
            <IconPlus /> Add
          </button>
        </>
      }
    >
      <div className="rack" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="rack-rows">
          {project.channels.map((ch) => (
            <RackRow
              key={ch.id}
              ch={ch}
              project={project}
              pattern={pattern}
              nSteps={nSteps}
              spb={spb}
              selected={selected === ch.id}
              error={codeErrors[ch.id]}
              ledRef={(el) => (el ? leds.current.set(ch.id, el) : leds.current.delete(ch.id))}
            />
          ))}
          {!project.channels.length && <div className="empty-hint">No channels yet — drag a sound from the browser or click “Add”.</div>}
          <div className="rack-playhead-wrap" style={{ left: 'var(--rack-left)' }}>
            <div className="rack-playhead" ref={playhead} style={{ width: STEP_W }} />
          </div>
        </div>
        <div className="rack-footer">
          <button className="rack-add" onClick={(e) => openMenuAt(e.currentTarget, addChannelMenu())} title="Add channel">
            +
          </button>
          <span className="muted">
            {pattern ? `${pattern.name} · ${pattern.bars} bar${pattern.bars > 1 ? 's' : ''}` : ''} — click steps to toggle, drag to paint, right-drag to erase, Alt+drag = velocity
          </span>
          <span className="spacer" />
          {pattern && (
            <span className="bars-ctl">
              Length
              <button onClick={() => A.setPatternBars(pattern.id, pattern.bars - 1)}>−</button>
              <b>{pattern.bars}</b>
              <button onClick={() => A.setPatternBars(pattern.id, pattern.bars + 1)}>+</button>
              bars
            </span>
          )}
        </div>
      </div>
    </Window>
  );
}

interface RowProps {
  ch: Channel;
  project: Project;
  pattern: Pattern | undefined;
  nSteps: number;
  spb: number;
  selected: boolean;
  error?: string;
  ledRef: (el: HTMLElement | null) => void;
}

const RackRow = memo(function RackRow({ ch, project, pattern, nSteps, spb, selected, error, ledRef }: RowProps) {
  const notes = pattern?.notes[ch.id] ?? [];
  const hasNotes = notes.length > 0;
  const setHint = useStudio((s) => s.setHint);

  const onNameDrop = (e: React.DragEvent) => {
    const item = libFromDrag(e);
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    A.replaceChannelSound(ch.id, item);
  };

  return (
    <div className={'rack-row' + (selected ? ' selected' : '') + (ch.mute ? ' muted' : '')} onContextMenu={(e) => openContextMenu(e, channelMenu(ch, pattern, project))}>
      <button
        className={'led-btn' + (ch.mute ? '' : ' lit')}
        title="Mute (right-click: solo)"
        onClick={() => A.toggleMute(ch.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          A.toggleSolo(ch.id);
        }}
      >
        {ch.solo ? 'S' : ''}
      </button>
      <Knob size={20} value={ch.pan} min={0} max={1} def={0.5} bipolar label="" format={(v) => (v === 0.5 ? 'C' : v < 0.5 ? `${Math.round((0.5 - v) * 200)}L` : `${Math.round((v - 0.5) * 200)}R`)} onChange={(v) => A.setChannel(ch.id, { pan: v }, `pan:${ch.id}`)} hint="Channel pan" />
      <Knob size={20} value={ch.volume} min={0} max={1.5} def={0.8} label="" format={(v) => Math.round(v * 100) + '%'} onChange={(v) => A.setChannel(ch.id, { volume: v }, `vol:${ch.id}`)} hint="Channel volume" />
      <input
        className="insert-box"
        title="Mixer insert (scroll to change)"
        value={ch.insert === 0 ? '—' : ch.insert}
        readOnly
        onWheel={(e) => {
          e.stopPropagation();
          const d = e.deltaY < 0 ? 1 : -1;
          A.setChannel(ch.id, { insert: Math.max(0, Math.min(project.mixer.length - 1, ch.insert + d)) });
        }}
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            project.mixer.map((m, i) => ({ label: i === 0 ? 'Master' : `${i} · ${m.name}`, checked: i === ch.insert, onClick: () => A.setChannel(ch.id, { insert: i }) })),
          )
        }
      />
      <div
        className="ch-name"
        style={{ '--ch': ch.color } as React.CSSProperties}
        onClick={() => {
          useStudio.setState({ channelId: ch.id });
          engine.previewChannel(getState().project, ch);
        }}
        onDoubleClick={() => openSettings(ch.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onNameDrop}
        onMouseEnter={() => setHint(`${ch.name} · ${ch.kind === 'vst' ? 'VST3 ' + (ch.vst?.name ?? '(no plug-in)') : ch.kind + (ch.bank ? ' ' + ch.bank : '') + ' ' + ch.sound} — click: select & preview, double-click: settings, right-click: menu, drop a sound here to replace`)}
        title={ch.name}
      >
        <span className="ch-led" ref={ledRef} />
        <span className="ch-label">{ch.name}</span>
        <span className="ch-kind">{kindBadge(ch)}</span>
      </div>
      <div className="rack-content">
        {ch.kind === 'code' ? (
          <CodeCell ch={ch} pattern={pattern} error={error} />
        ) : hasNotes ? (
          <NotesPreview notes={notes} bars={pattern!.bars} tpb={ticksPerBar(project)} color={ch.color} width={nSteps * STEP_W} onOpen={() => openPianoRoll(ch.id)} />
        ) : (
          <Steps ch={ch} project={project} pattern={pattern} nSteps={nSteps} spb={spb} />
        )}
      </div>
    </div>
  );
});

function kindBadge(ch: Channel) {
  switch (ch.kind) {
    case 'sample':
      return 'SMP';
    case 'synth':
      return 'SYN';
    case 'soundfont':
      return 'SF2';
    case 'plugin':
      return 'PLG';
    case 'vst':
      return 'VST3';
    case 'code':
      return '{ }';
  }
}

function CodeCell({ ch, pattern, error }: { ch: Channel; pattern: Pattern | undefined; error?: string }) {
  const on = !!pattern?.code[ch.id];
  return (
    <div className="code-cell">
      <button className={'code-toggle' + (on ? ' on' : '')} onClick={() => pattern && A.setCodeEnabled(pattern.id, ch.id, !on)} title="Play this code channel in the current pattern">
        {on ? '● ON' : '○ OFF'}
      </button>
      <code className={'code-snippet' + (error ? ' error' : '')} onClick={() => openSettings(ch.id)} title={error ?? 'Click to edit the Strudel code'}>
        {error ? '⚠ ' : ''}
        {ch.code.replace(/\s+/g, ' ').slice(0, 120)}
      </code>
    </div>
  );
}

function NotesPreview({ notes, bars, tpb, color, width, onOpen }: { notes: Pattern['notes'][string]; bars: number; tpb: number; color: string; width: number; onOpen: () => void }) {
  const total = bars * tpb;
  const keys = notes.map((n) => n.key);
  const lo = Math.min(...keys);
  const hi = Math.max(...keys);
  const range = Math.max(1, hi - lo + 1);
  return (
    <div className="notes-preview" style={{ width }} onClick={onOpen} title="Piano roll content — click to edit">
      {notes.map((n) => (
        <i
          key={n.id}
          style={{
            left: `${(n.start / total) * 100}%`,
            width: `${Math.max(0.4, (n.len / total) * 100)}%`,
            top: `${(1 - (n.key - lo + 1) / range) * 80 + 6}%`,
            background: color,
          }}
        />
      ))}
    </div>
  );
}

function Steps({ ch, project, pattern, nSteps, spb }: { ch: Channel; project: Project; pattern: Pattern | undefined; nSteps: number; spb: number }) {
  const steps = pattern ? getSteps(project, pattern, ch.id) : [];
  const paint = useRef<{ value: number; mode: 'paint' | 'vel'; startY: number; startVel: number; index: number; key: string } | null>(null);
  if (!pattern) return null;
  const pid = pattern.id;

  const idxFromEvent = (e: React.PointerEvent) => {
    const el = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.floor((e.clientX - el.left) / STEP_W);
  };

  const onDown = (e: React.PointerEvent) => {
    const i = idxFromEvent(e);
    if (i < 0 || i >= nSteps) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const cur = steps[i];
    if (e.altKey) {
      paint.current = { value: 0, mode: 'vel', startY: e.clientY, startVel: cur || 1, index: i, key: `vel:${ch.id}:${e.timeStamp}` };
      if (!cur) A.setStep(pid, ch.id, i, 1, paint.current.key);
      return;
    }
    const value = e.button === 2 ? 0 : cur > 0 ? 0 : 1;
    paint.current = { value, mode: 'paint', startY: e.clientY, startVel: 0, index: i, key: `paint:${ch.id}:${e.timeStamp}` };
    A.setStep(pid, ch.id, i, value, paint.current.key);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = paint.current;
    if (!p) return;
    if (p.mode === 'vel') {
      const v = Math.max(0.05, Math.min(1, p.startVel + (p.startY - e.clientY) / 80));
      A.setStep(pid, ch.id, p.index, v, p.key);
      useStudio.getState().setHint(`Velocity: ${Math.round(v * 100)}%`);
      return;
    }
    const i = idxFromEvent(e);
    if (i < 0 || i >= nSteps || i === p.index) return;
    p.index = i;
    const cur = getSteps(getState().project, getState().project.patterns.find((x) => x.id === pid)!, ch.id)[i];
    if ((cur > 0) !== p.value > 0) A.setStep(pid, ch.id, i, p.value, p.key);
  };
  const onUp = () => (paint.current = null);

  return (
    <div
      className="steps"
      style={{ width: nSteps * STEP_W, '--ch': ch.color } as React.CSSProperties}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {steps.map((v, i) => {
        const beat = Math.floor(i / 4);
        const bar = Math.floor(i / spb);
        return (
          <div key={i} className={'step' + (beat % 2 ? ' alt' : '') + (v > 0 ? ' on' : '') + (i % spb === 0 && bar > 0 ? ' barline' : '')}>
            {v > 0 && <i style={{ height: `${Math.round(v * 100)}%` }} />}
          </div>
        );
      })}
    </div>
  );
}
