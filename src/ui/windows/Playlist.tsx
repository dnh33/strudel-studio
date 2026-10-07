import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio, getState } from '../../store/store';
import type { Clip, Pattern, Project } from '../../model/types';
import { stepsPerBar, ticksPerBar } from '../../model/types';
import * as A from '../../store/actions';
import { Window } from '../components/Window';
import { engine } from '../../engine/engine';
import { useTick } from '../ticker';
import { openContextMenu, promptText, type MenuItem } from '../components/Menu';
import { songLengthBars } from '../../model/compile';
import { seek } from '../../store/transport';
import { uid } from '../../model/util';
import { IconErase, IconPencil, IconSelect, IconFollow } from '../components/Icons';
import { openPianoRoll } from './ChannelRack';

const TRACK_H = 46;
const RULER_H = 24;
const HEAD_W = 118;

type Tool = 'draw' | 'select' | 'erase';

interface Drag {
  kind: 'move' | 'resize' | 'box' | 'erase' | 'loop';
  x0: number;
  y0: number;
  bar0: number;
  track0: number;
  orig: Clip[];
  ids: Set<string>;
  anchor?: Clip;
  coalesce: string;
  moved?: boolean;
  copy?: boolean;
}

const SNAP_OPTIONS = [
  { label: 'Bar', div: 1 },
  { label: 'Beat', div: 4 },
  { label: 'Step', div: 16 },
  { label: 'None', div: 0 },
];

export function Playlist() {
  const project = useStudio((s) => s.project);
  const patternId = useStudio((s) => s.patternId);
  const loop = useStudio((s) => s.loop);
  const startBar = useStudio((s) => s.startBar);
  const mode = useStudio((s) => s.mode);
  const follow = useStudio((s) => s.follow);
  const [zoom, setZoom] = useState(46); // px per bar
  const [tool, setTool] = useState<Tool>('draw');
  const [snapI, setSnapI] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const rulerHead = useRef<HTMLDivElement>(null);

  const song = songLengthBars(project);
  const bars = Math.max(song + 16, 64);
  const width = bars * zoom;
  const tracks = project.tracks;
  const snapDiv = SNAP_OPTIONS[snapI].div;
  const beatsPerBar = project.beatsPerBar;
  const snapBar = (b: number) => {
    if (!snapDiv) return Math.max(0, b);
    const d = snapDiv === 4 ? beatsPerBar : snapDiv === 16 ? stepsPerBar(project) : 1;
    return Math.max(0, Math.round(b * d) / d);
  };
  const floorBar = (b: number) => {
    if (!snapDiv) return Math.max(0, b);
    const d = snapDiv === 4 ? beatsPerBar : snapDiv === 16 ? stepsPerBar(project) : 1;
    return Math.max(0, Math.floor(b * d) / d);
  };

  useTick(() => {
    const ph = playhead.current;
    const rh = rulerHead.current;
    if (!ph || !rh) return;
    const s = getState();
    const pos = engine.position();
    if (pos === null || s.mode !== 'song') {
      ph.style.display = 'none';
      rh.style.display = 'none';
      return;
    }
    const x = pos * zoom;
    ph.style.display = 'block';
    rh.style.display = 'block';
    ph.style.transform = `translateX(${x}px)`;
    rh.style.transform = `translateX(${x}px)`;
    const el = scroller.current;
    if (s.follow && el && !drag.current) {
      const view = el.clientWidth - HEAD_W;
      const left = el.scrollLeft;
      if (x < left || x > left + view - 20) el.scrollLeft = Math.max(0, x - 40);
    }
  });

  const point = (e: { clientX: number; clientY: number }) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft - HEAD_W;
    const y = e.clientY - r.top + el.scrollTop - RULER_H;
    return { x, y, bar: x / zoom, track: Math.floor(y / TRACK_H) };
  };

  const clipAt = (bar: number, track: number) => [...project.clips].reverse().find((c) => c.track === track && bar >= c.start && bar < c.start + c.length);

  const onGridDown = (e: React.PointerEvent) => {
    const p = point(e);
    if (p.track < 0 || p.track >= tracks.length || p.x < 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const hit = clipAt(p.bar, p.track);
    const coalesce = 'pl:' + e.timeStamp;
    if (e.button === 2 || tool === 'erase') {
      if (hit && e.button === 2 && e.shiftKey) {
        openContextMenu(e, clipMenu(hit, project));
        return;
      }
      drag.current = { kind: 'erase', x0: p.x, y0: p.y, bar0: p.bar, track0: p.track, orig: project.clips, ids: new Set(), coalesce };
      if (hit) A.deleteClips([hit.id]);
      return;
    }
    if (hit) {
      const edge = (hit.start + hit.length) * zoom - p.x < Math.min(10, hit.length * zoom * 0.3);
      let ids = sel;
      if (!sel.has(hit.id)) {
        ids = e.ctrlKey ? new Set([...sel, hit.id]) : new Set([hit.id]);
        setSel(ids);
      }
      if (hit.kind === 'pattern' && hit.patternId) A.selectPattern(hit.patternId);
      if (hit.kind === 'automation') useStudio.setState({ automationClipId: hit.id });
      drag.current = { kind: edge ? 'resize' : 'move', x0: p.x, y0: p.y, bar0: p.bar, track0: p.track, orig: project.clips, ids, anchor: hit, coalesce, copy: e.shiftKey };
      return;
    }
    if (tool === 'select' || e.ctrlKey) {
      drag.current = { kind: 'box', x0: p.x, y0: p.y, bar0: p.bar, track0: p.track, orig: project.clips, ids: new Set(), coalesce };
      setSel(new Set());
      return;
    }
    // paint the selected pattern
    const pt = project.patterns.find((x) => x.id === patternId);
    if (!pt) return;
    const start = floorBar(p.bar);
    const clip: Clip = { id: uid('cl'), kind: 'pattern', patternId: pt.id, track: p.track, start, length: pt.bars };
    A.updateClips((clips) => {
      clips.push(clip);
    }, coalesce);
    setSel(new Set([clip.id]));
    drag.current = { kind: 'move', x0: p.x, y0: p.y, bar0: p.bar, track0: p.track, orig: [...project.clips, clip], ids: new Set([clip.id]), anchor: clip, coalesce };
  };

  const onGridMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (d.kind === 'erase') {
      const cur = getState().project.clips;
      const hit = [...cur].reverse().find((c) => c.track === p.track && p.bar >= c.start && p.bar < c.start + c.length);
      if (hit) A.deleteClips([hit.id]);
      return;
    }
    if (d.kind === 'box') {
      const x = Math.min(d.x0, p.x);
      const y = Math.min(d.y0, p.y);
      const w = Math.abs(p.x - d.x0);
      const h = Math.abs(p.y - d.y0);
      setBox({ x, y, w, h });
      const b0 = x / zoom;
      const b1 = (x + w) / zoom;
      const t0 = Math.floor(y / TRACK_H);
      const t1 = Math.floor((y + h) / TRACK_H);
      setSel(new Set(project.clips.filter((c) => c.track >= t0 && c.track <= t1 && c.start < b1 && c.start + c.length > b0).map((c) => c.id)));
      return;
    }
    const anchor = d.anchor!;
    if (d.kind === 'move') {
      let db = snapBar(anchor.start + (p.bar - d.bar0)) - anchor.start;
      let dt = p.track - d.track0;
      const moving = d.orig.filter((c) => d.ids.has(c.id));
      const minStart = Math.min(...moving.map((c) => c.start));
      const minTrack = Math.min(...moving.map((c) => c.track));
      const maxTrack = Math.max(...moving.map((c) => c.track));
      if (minStart + db < 0) db = -minStart;
      if (minTrack + dt < 0) dt = -minTrack;
      if (maxTrack + dt >= tracks.length) dt = tracks.length - 1 - maxTrack;
      if (!d.moved && Math.abs(p.x - d.x0) < 3 && Math.abs(p.y - d.y0) < 3) return;
      d.moved = true;
      A.updateClips((clips) => {
        if (d.copy) {
          // shift-drag: duplicate the selection (temporary ids until pointer up)
          for (let i = clips.length - 1; i >= 0; i--) if (clips[i].id.startsWith('dup')) clips.splice(i, 1);
          for (const c of moving) clips.push({ ...c, id: 'dup' + c.id, start: c.start + db, track: c.track + dt });
        } else {
          for (const c of clips) {
            const o = moving.find((m) => m.id === c.id);
            if (o) {
              c.start = o.start + db;
              c.track = o.track + dt;
            }
          }
        }
      }, d.coalesce);
      return;
    }
    if (d.kind === 'resize') {
      const end = Math.max(anchor.start + (snapDiv ? 1 / (snapDiv === 1 ? 1 : snapDiv === 4 ? beatsPerBar : stepsPerBar(project)) : 0.01), snapBar(p.bar));
      const dl = end - (anchor.start + anchor.length);
      A.updateClips((clips) => {
        for (const c of clips) {
          const o = d.orig.find((m) => m.id === c.id);
          if (o && d.ids.has(c.id)) c.length = Math.max(0.0625, o.length + dl);
        }
      }, d.coalesce);
    }
  };

  const onGridUp = () => {
    const d = drag.current;
    if (d?.copy && d.moved) {
      // give duplicated clips real ids
      A.updateClips((clips) => {
        for (const c of clips) if (c.id.startsWith('dup')) c.id = uid('cl');
      }, d.coalesce);
    }
    drag.current = null;
    setBox(null);
  };

  const onDouble = (e: React.MouseEvent) => {
    const p = point(e);
    const hit = clipAt(p.bar, p.track);
    if (!hit) return;
    if (hit.kind === 'automation') {
      useStudio.setState({ automationClipId: hit.id });
      getState().openWindow('automation');
    } else if (hit.patternId) {
      A.selectPattern(hit.patternId);
      const pt = project.patterns.find((x) => x.id === hit.patternId);
      const withNotes = pt && Object.keys(pt.notes).find((k) => pt.notes[k].length);
      if (withNotes) openPianoRoll(withNotes);
      else getState().openWindow('channelRack');
    }
  };

  // ruler: click = set position, drag = loop region
  const onRulerDown = (e: React.PointerEvent) => {
    const p = point(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'loop', x0: p.x, y0: 0, bar0: floorBar(p.bar), track0: 0, orig: [], ids: new Set(), coalesce: '' };
  };
  const onRulerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.kind !== 'loop') return;
    const p = point(e);
    if (Math.abs(p.x - d.x0) < 4 && !d.moved) return;
    d.moved = true;
    const a = Math.min(d.bar0, snapBar(p.bar));
    const b = Math.max(d.bar0, snapBar(p.bar));
    if (b > a) useStudio.setState({ loop: { start: a, end: b } });
  };
  const onRulerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind !== 'loop') return;
    if (!d.moved) {
      const p = point(e);
      seek(floorBar(p.bar));
      if (getState().mode !== 'song') useStudio.setState({ mode: 'song' });
    } else {
      const l = getState().loop;
      if (l) seek(l.start);
    }
  };

  // keyboard: delete, duplicate
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
      A.deleteClips([...sel]);
      setSel(new Set());
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && sel.size) {
      e.preventDefault();
      const chosen = project.clips.filter((c) => sel.has(c.id));
      const minS = Math.min(...chosen.map((c) => c.start));
      const maxE = Math.max(...chosen.map((c) => c.start + c.length));
      const copies = chosen.map((c) => ({ ...c, id: uid('cl'), start: c.start + (maxE - minS) }));
      A.updateClips((clips) => {
        clips.push(...copies);
      });
      setSel(new Set(copies.map((c) => c.id)));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel(new Set(project.clips.map((c) => c.id)));
    }
  };

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const z = zoomRef.current;
      const bar = (e.clientX - r.left + el.scrollLeft - HEAD_W) / z;
      const nz = Math.max(8, Math.min(400, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setZoom(nz);
      requestAnimationFrame(() => (el.scrollLeft = bar * nz - (e.clientX - r.left - HEAD_W)));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  });

  const ruler = useMemo(() => {
    const out = [];
    const every = zoom < 14 ? 8 : zoom < 28 ? 4 : zoom < 60 ? 2 : 1;
    for (let b = 0; b < bars; b += every) {
      out.push(
        <span key={b} style={{ left: b * zoom }}>
          {b + 1}
        </span>,
      );
    }
    return out;
  }, [bars, zoom]);

  const gridBg = {
    width,
    height: tracks.length * TRACK_H,
    backgroundImage: [
      `repeating-linear-gradient(to bottom, transparent 0 ${TRACK_H - 1}px, rgba(0,0,0,.35) ${TRACK_H - 1}px ${TRACK_H}px)`,
      `repeating-linear-gradient(to right, rgba(0,0,0,.45) 0 1px, transparent 1px ${zoom * 4}px)`,
      `repeating-linear-gradient(to right, rgba(0,0,0,.2) 0 1px, transparent 1px ${zoom}px)`,
    ].join(','),
  } as React.CSSProperties;

  const toolbar = (
    <>
      <div className="seg">
        <button className={tool === 'draw' ? 'on' : ''} onClick={() => setTool('draw')} title="Paint the selected pattern">
          <IconPencil />
        </button>
        <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Select (or Ctrl+drag)">
          <IconSelect />
        </button>
        <button className={tool === 'erase' ? 'on' : ''} onClick={() => setTool('erase')} title="Erase (or right-click)">
          <IconErase />
        </button>
      </div>
      <label className="tb-label">Snap</label>
      <select value={snapI} onChange={(e) => setSnapI(+e.target.value)}>
        {SNAP_OPTIONS.map((s, i) => (
          <option key={s.label} value={i}>
            {s.label}
          </option>
        ))}
      </select>
      <button className={'tb-btn' + (follow ? ' on' : '')} title="Follow playhead" onClick={() => useStudio.setState({ follow: !follow })}>
        <IconFollow />
      </button>
      {loop && (
        <button className="tb-btn on" title="Clear loop region" onClick={() => useStudio.setState({ loop: null })}>
          Loop {loop.start + 1}–{loop.end + 1} ✕
        </button>
      )}
      <span className="tb-label">
        Song: {song} bars · {fmtTime((song * beatsPerBar * 60) / project.bpm)}
      </span>
    </>
  );

  return (
    <Window id="playlist" title={`Playlist — ${mode === 'song' ? 'Song mode' : 'Arrangement'}`} toolbar={toolbar} minW={500} minH={200}>
      <div className="pl">
        <PatternList project={project} patternId={patternId} />
        <div className="pl-scroll" ref={scroller} tabIndex={0} onKeyDown={onKeyDown}>
          <div className="pl-inner" style={{ width: width + HEAD_W, height: tracks.length * TRACK_H + RULER_H }}>
            <div className="pl-ruler" style={{ width, left: HEAD_W }} onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} title="Click: set song position · drag: loop region · double-click: clear loop" onDoubleClick={() => useStudio.setState({ loop: null })}>
              {ruler}
              {loop && <div className="pl-loop" style={{ left: loop.start * zoom, width: (loop.end - loop.start) * zoom }} />}
              <div className="pl-start" style={{ left: startBar * zoom }} />
              <div className="pl-end-marker" style={{ left: song * zoom }} title="Song end" />
              <div className="ruler-head" ref={rulerHead} />
            </div>
            <div className="pl-heads" style={{ top: RULER_H }}>
              {tracks.map((t, i) => (
                <TrackHead key={t.id} index={i} project={project} />
              ))}
            </div>
            <div
              className={'pl-grid tool-' + tool}
              style={{ ...gridBg, left: HEAD_W, top: RULER_H }}
              onPointerDown={onGridDown}
              onPointerMove={onGridMove}
              onPointerUp={onGridUp}
              onDoubleClick={onDouble}
              onContextMenu={(e) => e.preventDefault()}
            >
              {loop && <div className="pl-loop-shade" style={{ left: loop.start * zoom, width: (loop.end - loop.start) * zoom }} />}
              {project.clips.map((c) => (
                <ClipView key={c.id} clip={c} project={project} zoom={zoom} selected={sel.has(c.id)} muted={project.tracks[c.track]?.mute} />
              ))}
              {box && <div className="pr-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
              <div className="playhead" ref={playhead} style={{ height: tracks.length * TRACK_H }} />
            </div>
          </div>
        </div>
      </div>
    </Window>
  );
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function clipMenu(c: Clip, project: Project): MenuItem[] {
  const pt = project.patterns.find((p) => p.id === c.patternId);
  return [
    { label: c.kind === 'automation' ? c.automation?.name ?? 'Automation' : pt?.name ?? 'Clip', disabled: true },
    ...(c.kind === 'automation'
      ? [{ label: 'Edit automation…', onClick: () => (useStudio.setState({ automationClipId: c.id }), getState().openWindow('automation')) }]
      : [
          { label: 'Open in channel rack', onClick: () => (A.selectPattern(c.patternId!), getState().openWindow('channelRack')) },
          { label: 'Make unique', hint: 'Clone the pattern so this clip can be edited separately', onClick: () => A.makeClipUnique(c.id) },
          { label: 'Rename pattern…', onClick: () => pt && promptText('Rename pattern', pt.name, (v) => v && A.setPattern(pt.id, { name: v })) },
        ]),
    { label: 'Fit length to pattern', disabled: !pt, onClick: () => A.updateClips((cl) => { const x = cl.find((y) => y.id === c.id); if (x && pt) x.length = pt.bars; }) },
    { separator: true },
    { label: 'Delete', danger: true, onClick: () => A.deleteClips([c.id]) },
  ];
}

function TrackHead({ index, project }: { index: number; project: Project }) {
  const t = project.tracks[index];
  const toggle = () => A.updateClips((_, p) => { p.tracks[index].mute = !p.tracks[index].mute; });
  return (
    <div
      className={'pl-head' + (t.mute ? ' muted' : '')}
      style={{ height: TRACK_H }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Rename…', onClick: () => promptText('Rename track', t.name, (v) => v && A.updateClips((_, p) => { p.tracks[index].name = v; })) },
          { label: 'Mute', checked: t.mute, onClick: toggle },
          { label: 'Clear track', danger: true, onClick: () => A.deleteClips(project.clips.filter((c) => c.track === index).map((c) => c.id)) },
        ])
      }
    >
      <button className={'led-btn' + (t.mute ? '' : ' lit')} onClick={toggle} title="Mute track" />
      <span onDoubleClick={() => promptText('Rename track', t.name, (v) => v && A.updateClips((_, p) => { p.tracks[index].name = v; }))}>{t.name}</span>
    </div>
  );
}

function PatternList({ project, patternId }: { project: Project; patternId: string }) {
  return (
    <div className="pl-patterns">
      <div className="pl-patterns-title">Patterns</div>
      {project.patterns.map((p, i) => (
        <div
          key={p.id}
          className={'pl-pattern' + (p.id === patternId ? ' on' : '')}
          onClick={() => A.selectPattern(p.id)}
          onDoubleClick={() => getState().openWindow('channelRack')}
          onContextMenu={(e) =>
            openContextMenu(e, [
              { label: 'Rename…', onClick: () => promptText('Rename pattern', p.name, (v) => v && A.setPattern(p.id, { name: v })) },
              { label: 'Clone', onClick: () => A.clonePattern(p.id) },
              { label: 'Delete', danger: true, disabled: project.patterns.length <= 1, onClick: () => A.deletePattern(p.id) },
            ])
          }
          title="Click to select as brush, double-click to edit"
        >
          <i style={{ background: p.color }} />
          {i + 1}. {p.name}
        </div>
      ))}
      <button className="pl-new" onClick={() => A.addPattern()}>
        + New pattern
      </button>
    </div>
  );
}

function ClipView({ clip, project, zoom, selected, muted }: { clip: Clip; project: Project; zoom: number; selected: boolean; muted?: boolean }) {
  const pt = clip.kind === 'pattern' ? project.patterns.find((p) => p.id === clip.patternId) : undefined;
  const color = clip.kind === 'automation' ? '#7fd1b9' : pt?.color ?? '#888';
  const w = clip.length * zoom;
  return (
    <div
      className={'clip' + (selected ? ' sel' : '') + (muted ? ' muted' : '') + (clip.kind === 'automation' ? ' auto' : '')}
      style={{ left: clip.start * zoom, top: clip.track * TRACK_H + 1, width: Math.max(4, w - 1), height: TRACK_H - 3, '--clip': color } as React.CSSProperties}
    >
      <div className="clip-name">{clip.kind === 'automation' ? '⟋ ' + (clip.automation?.name ?? 'Automation') : pt?.name ?? '?'}</div>
      <div className="clip-body">{clip.kind === 'automation' ? <AutoPreview clip={clip} /> : pt ? <PatternPreview pattern={pt} project={project} clip={clip} /> : null}</div>
    </div>
  );
}

function AutoPreview({ clip }: { clip: Clip }) {
  const pts = [...(clip.automation?.points ?? [])].sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x * 100} ${(1 - p.y) * 100}`).join(' ');
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="clip-svg">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PatternPreview({ pattern, project, clip }: { pattern: Pattern; project: Project; clip: Clip }) {
  // draw each channel's events as tiny marks, looping across the clip length
  const tpb = ticksPerBar(project);
  const spb = stepsPerBar(project);
  const marks = useMemo(() => {
    const out: { x: number; y: number; w: number; c: string }[] = [];
    const chans = project.channels.filter((c) => (pattern.notes[c.id]?.length ?? 0) > 0 || (pattern.steps[c.id] ?? []).some((v) => v > 0) || pattern.code[c.id]);
    const rows = Math.max(1, chans.length);
    chans.forEach((ch, row) => {
      const y = (row + 0.5) / rows;
      const notes = pattern.notes[ch.id] ?? [];
      if (notes.length) for (const n of notes) out.push({ x: n.start / tpb, y, w: n.len / tpb, c: ch.color });
      else if (pattern.code[ch.id]) out.push({ x: 0, y, w: pattern.bars, c: ch.color });
      else (pattern.steps[ch.id] ?? []).forEach((v, i) => v > 0 && out.push({ x: i / spb, y, w: 0.5 / spb, c: ch.color }));
    });
    return out;
  }, [pattern, project.channels, tpb, spb]);
  const reps = Math.ceil(clip.length / pattern.bars);
  const L = clip.length;
  return (
    <svg viewBox={`0 0 ${L} 1`} preserveAspectRatio="none" className="clip-svg">
      {Array.from({ length: Math.min(reps, 64) }, (_, r) =>
        marks.map((m, i) => {
          const x = r * pattern.bars + m.x;
          if (x >= L) return null;
          return <rect key={r + ':' + i} x={x} y={m.y - 0.06} width={Math.min(m.w, L - x)} height={0.12} fill={m.c} />;
        }),
      )}
    </svg>
  );
}
