import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio, getState } from '../../store/store';
import type { Note } from '../../model/types';
import { ticksPerBar, PPQ } from '../../model/types';
import * as A from '../../store/actions';
import { Window } from '../components/Window';
import { engine } from '../../engine/engine';
import { patternPlayhead } from '../../store/transport';
import { useTick } from '../ticker';
import { isBlackKey, midiToName, uid } from '../../model/util';
import { CHORDS, ROOTS, SCALES, SNAPS, inScale } from '../../model/music';
import { openMenuAt } from '../components/Menu';
import { IconErase, IconPencil, IconSelect } from '../components/Icons';

const ROW = 14;
const KEYS = 128;
const KEYBOARD_W = 58;
const VEL_H = 64;

type Tool = 'draw' | 'select' | 'erase';

interface Drag {
  kind: 'move' | 'resize' | 'box' | 'erase' | 'vel';
  x0: number;
  y0: number;
  tick0: number;
  key0: number;
  orig: Note[];
  ids: Set<string>;
  coalesce: string;
  anchor?: Note;
  moved?: boolean;
}

let clipboard: Note[] = [];

export function PianoRoll() {
  const project = useStudio((s) => s.project);
  const patternId = useStudio((s) => s.patternId);
  const chId = useStudio((s) => s.channelId);
  const pattern = project.patterns.find((p) => p.id === patternId);
  const channel = project.channels.find((c) => c.id === chId);
  const notes = useMemo(() => (pattern && chId ? pattern.notes[chId] ?? [] : []), [pattern, chId]);
  const tpb = ticksPerBar(project);

  const [tool, setTool] = useState<Tool>('draw');
  const [snapIdx, setSnapIdx] = useState(4);
  const [zoom, setZoom] = useState(0.7); // px per tick
  const [chord, setChord] = useState('Off');
  const [root, setRoot] = useState(9);
  const [scale, setScale] = useState('None');
  const [ghosts, setGhosts] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const lastLen = useRef(96);
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLDivElement>(null);
  const velLane = useRef<HTMLDivElement>(null);

  const snap = SNAPS[snapIdx].ticks === -1 ? tpb : SNAPS[snapIdx].ticks;
  const bars = pattern?.bars ?? 1;
  const totalTicks = (bars + 1) * tpb;
  const width = totalTicks * zoom;
  const height = KEYS * ROW;
  const scaleSteps = SCALES[scale];

  // scroll to the notes (or middle C) on open / channel change
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const keys = notes.map((n) => n.key);
    const center = keys.length ? (Math.max(...keys) + Math.min(...keys)) / 2 : channel?.rootNote ?? 60;
    el.scrollTop = Math.max(0, (127 - center) * ROW - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chId, patternId]);

  useEffect(() => setSel(new Set()), [chId, patternId]);

  // sync keyboard + velocity lane scroll with the grid
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (keyboard.current) keyboard.current.style.transform = `translateY(${-el.scrollTop}px)`;
    if (velLane.current) velLane.current.style.transform = `translateX(${-el.scrollLeft}px)`;
  };

  useTick(() => {
    const ph = playhead.current;
    if (!ph) return;
    const pos = patternPlayhead();
    if (pos === null) {
      ph.style.display = 'none';
      return;
    }
    ph.style.display = 'block';
    ph.style.transform = `translateX(${pos * tpb * zoom}px)`;
  });

  const commit = (next: Note[], coalesce?: string) => {
    if (!pattern || !chId) return;
    A.setNotes(pattern.id, chId, next, coalesce);
  };

  const pointToTickKey = (e: { clientX: number; clientY: number }) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft;
    const y = e.clientY - r.top + el.scrollTop;
    return { x, y, tick: x / zoom, key: 127 - Math.floor(y / ROW) };
  };
  const snapTick = (t: number) => Math.max(0, Math.floor(t / snap) * snap);

  const preview = (key: number, vel = 0.9) => {
    if (channel) engine.previewChannel(getState().project, channel, key, vel, 0.3);
  };

  const noteAt = (tick: number, key: number) =>
    [...notes].reverse().find((n) => n.key === key && tick >= n.start && tick < n.start + n.len);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pattern || !channel) return;
    if ((e.target as HTMLElement).closest('.pr-velocity')) return;
    const p = pointToTickKey(e);
    if (p.key < 0 || p.key > 127) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const hit = noteAt(p.tick, p.key);
    const coalesce = 'pr:' + e.timeStamp;

    if (e.button === 2 || tool === 'erase') {
      drag.current = { kind: 'erase', x0: p.x, y0: p.y, tick0: p.tick, key0: p.key, orig: notes, ids: new Set(), coalesce };
      if (hit) commit(notes.filter((n) => n.id !== hit.id), coalesce);
      return;
    }
    if (hit) {
      const edge = (hit.start + hit.len) * zoom - p.x < Math.max(5, Math.min(10, hit.len * zoom * 0.3));
      let ids = sel;
      if (!sel.has(hit.id)) {
        ids = e.shiftKey ? new Set([...sel, hit.id]) : new Set([hit.id]);
        setSel(ids);
      }
      lastLen.current = hit.len;
      if (!edge) preview(hit.key, hit.vel);
      drag.current = { kind: edge ? 'resize' : 'move', x0: p.x, y0: p.y, tick0: p.tick, key0: p.key, orig: notes, ids, coalesce, anchor: hit };
      return;
    }
    if (tool === 'select' || e.ctrlKey || e.metaKey) {
      drag.current = { kind: 'box', x0: p.x, y0: p.y, tick0: p.tick, key0: p.key, orig: notes, ids: e.shiftKey ? new Set(sel) : new Set(), coalesce };
      if (!e.shiftKey) setSel(new Set());
      return;
    }
    // draw a new note (or chord)
    const start = snapTick(p.tick);
    const offsets = CHORDS[chord] ?? [0];
    const created: Note[] = offsets
      .map((o) => p.key + o)
      .filter((k) => k <= 127)
      .map((k) => ({ id: uid('n'), key: k, start, len: lastLen.current, vel: 0.8 }));
    const next = [...notes, ...created];
    commit(next, coalesce);
    const ids = new Set(created.map((n) => n.id));
    setSel(ids);
    preview(p.key);
    drag.current = { kind: 'move', x0: p.x, y0: p.y, tick0: p.tick, key0: p.key, orig: next, ids, coalesce, anchor: created[0] };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pointToTickKey(e);
    if (d.kind === 'erase') {
      const cur = getState().project.patterns.find((x) => x.id === patternId)?.notes[chId!] ?? [];
      const hit = cur.find((n) => n.key === p.key && p.tick >= n.start && p.tick < n.start + n.len);
      if (hit) commit(cur.filter((n) => n.id !== hit.id), d.coalesce);
      return;
    }
    if (d.kind === 'box') {
      const x = Math.min(d.x0, p.x);
      const y = Math.min(d.y0, p.y);
      const w = Math.abs(p.x - d.x0);
      const h = Math.abs(p.y - d.y0);
      setBox({ x, y, w, h });
      const t0 = x / zoom;
      const t1 = (x + w) / zoom;
      const k1 = 127 - Math.floor(y / ROW);
      const k0 = 127 - Math.floor((y + h) / ROW);
      const ids = new Set(d.ids);
      for (const n of notes) if (n.key >= k0 && n.key <= k1 && n.start < t1 && n.start + n.len > t0) ids.add(n.id);
      setSel(ids);
      return;
    }
    if (d.kind === 'move') {
      let dt = e.altKey ? Math.round(p.tick - d.tick0) : Math.round((p.tick - d.tick0) / snap) * snap;
      const dk = p.key - d.key0;
      const minStart = Math.min(...d.orig.filter((n) => d.ids.has(n.id)).map((n) => n.start));
      if (minStart + dt < 0) dt = -minStart;
      if (dt === 0 && dk === 0 && !d.moved) return;
      d.moved = true;
      const next = d.orig.map((n) => (d.ids.has(n.id) ? { ...n, start: n.start + dt, key: Math.max(0, Math.min(127, n.key + dk)) } : n));
      if (dk !== 0 && d.anchor) {
        const nk = Math.max(0, Math.min(127, d.anchor.key + dk));
        if ((d as Drag & { lastKey?: number }).lastKey !== nk) {
          (d as Drag & { lastKey?: number }).lastKey = nk;
          preview(nk);
        }
      }
      commit(next, d.coalesce);
      return;
    }
    if (d.kind === 'resize') {
      const anchor = d.anchor!;
      const endRaw = p.tick;
      const end = e.altKey ? endRaw : Math.max(anchor.start + snap, Math.round(endRaw / snap) * snap);
      const dl = end - (anchor.start + anchor.len);
      const next = d.orig.map((n) => (d.ids.has(n.id) ? { ...n, len: Math.max(e.altKey ? 1 : Math.min(snap, n.len), n.len + dl) } : n));
      lastLen.current = Math.max(1, anchor.len + dl);
      commit(next, d.coalesce);
    }
  };

  const onPointerUp = () => {
    drag.current = null;
    setBox(null);
  };

  // keyboard shortcuts while the piano roll is focused (top window)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const w = s.windows.pianoRoll;
      if (!w.open || w.z !== s.zTop) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, .cm-editor')) return;
      const cur = s.project.patterns.find((x) => x.id === s.patternId)?.notes[s.channelId ?? ''] ?? [];
      const selected = cur.filter((n) => sel.has(n.id));
      const ctrl = e.ctrlKey || e.metaKey;
      const mod = (fn: (n: Note) => Note) => commit(cur.map((n) => (sel.has(n.id) ? fn(n) : n)));
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selected.length) return;
        e.preventDefault();
        commit(cur.filter((n) => !sel.has(n.id)));
        setSel(new Set());
      } else if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSel(new Set(cur.map((n) => n.id)));
      } else if (ctrl && e.key.toLowerCase() === 'c') {
        clipboard = selected.map((n) => ({ ...n }));
      } else if (ctrl && e.key.toLowerCase() === 'x') {
        clipboard = selected.map((n) => ({ ...n }));
        commit(cur.filter((n) => !sel.has(n.id)));
        setSel(new Set());
      } else if (ctrl && e.key.toLowerCase() === 'v') {
        if (!clipboard.length) return;
        e.preventDefault();
        const minS = Math.min(...clipboard.map((n) => n.start));
        const maxE = selected.length ? Math.max(...selected.map((n) => n.start + n.len)) : 0;
        const at = selected.length ? Math.ceil(maxE / snap) * snap : 0;
        const pasted = clipboard.map((n) => ({ ...n, id: uid('n'), start: n.start - minS + at }));
        commit([...cur, ...pasted]);
        setSel(new Set(pasted.map((n) => n.id)));
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        if (!selected.length) return;
        e.preventDefault();
        const minS = Math.min(...selected.map((n) => n.start));
        const maxE = Math.max(...selected.map((n) => n.start + n.len));
        const span = Math.ceil((maxE - minS) / snap) * snap;
        const dup = selected.map((n) => ({ ...n, id: uid('n'), start: n.start + span }));
        commit([...cur, ...dup]);
        setSel(new Set(dup.map((n) => n.id)));
      } else if (ctrl && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        const target = selected.length ? sel : new Set(cur.map((n) => n.id));
        commit(cur.map((n) => (target.has(n.id) ? { ...n, start: Math.round(n.start / snap) * snap } : n)));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!selected.length) return;
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        mod((n) => ({ ...n, key: Math.max(0, Math.min(127, n.key + d)) }));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!selected.length) return;
        e.preventDefault();
        const d = (e.key === 'ArrowRight' ? 1 : -1) * snap;
        if (d < 0 && Math.min(...selected.map((n) => n.start)) + d < 0) return;
        mod((n) => ({ ...n, start: n.start + d }));
      } else if (!s.typingKeyboard && e.key.toLowerCase() === 'p' && !ctrl) {
        setTool('draw');
      } else if (!s.typingKeyboard && e.key.toLowerCase() === 'e' && !ctrl) {
        setTool('select');
      } else if (!s.typingKeyboard && e.key.toLowerCase() === 'd' && !ctrl) {
        setTool('erase');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, snap, patternId, chId]);

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
      const tick = (e.clientX - r.left + el.scrollLeft) / z;
      const nz = Math.max(0.08, Math.min(4, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setZoom(nz);
      requestAnimationFrame(() => {
        el.scrollLeft = tick * nz - (e.clientX - r.left);
      });
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  });
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey && false) {
      e.preventDefault();
      const el = scroller.current!;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left + el.scrollLeft;
      const tick = mx / zoom;
      const nz = Math.max(0.08, Math.min(4, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setZoom(nz);
      requestAnimationFrame(() => {
        el.scrollLeft = tick * nz - (e.clientX - r.left);
      });
    }
  };

  // velocity lane
  const velDown = (e: React.PointerEvent) => {
    const lane = e.currentTarget as HTMLElement;
    lane.setPointerCapture(e.pointerId);
    drag.current = { kind: 'vel', x0: 0, y0: 0, tick0: 0, key0: 0, orig: notes, ids: new Set(), coalesce: 'vel:' + e.timeStamp };
    velMove(e);
  };
  const velMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.kind !== 'vel') return;
    const lane = e.currentTarget as HTMLElement;
    const r = lane.getBoundingClientRect();
    const tick = (e.clientX - r.left) / zoom;
    const v = Math.max(0.02, Math.min(1, 1 - (e.clientY - r.top) / VEL_H));
    const cur = getState().project.patterns.find((x) => x.id === patternId)?.notes[chId!] ?? [];
    const target = cur.filter((n) => Math.abs(n.start - tick) < Math.max(6 / zoom, 4));
    if (!target.length) return;
    const ids = new Set(target.some((n) => sel.has(n.id)) ? [...sel] : target.map((n) => n.id));
    commit(cur.map((n) => (ids.has(n.id) ? { ...n, vel: v } : n)), d.coalesce);
    getState().setHint(`Velocity ${Math.round(v * 100)}%`);
  };

  const ghostNotes = useMemo(() => {
    if (!ghosts || !pattern) return [];
    return Object.entries(pattern.notes)
      .filter(([id]) => id !== chId)
      .flatMap(([id, ns]) => {
        const c = project.channels.find((x) => x.id === id);
        return c ? ns.map((n) => ({ ...n, color: c.color })) : [];
      });
  }, [ghosts, pattern, chId, project.channels]);

  const rows = useMemo(() => {
    const out = [];
    for (let k = 127; k >= 0; k--) {
      const black = isBlackKey(k);
      const inS = scaleSteps.length ? inScale(k, root, scaleSteps) : true;
      out.push(
        <div
          key={k}
          className={'pr-row' + (black ? ' black' : '') + (k % 12 === 0 ? ' c' : '') + (!inS ? ' out' : scaleSteps.length && (k - root) % 12 === 0 ? ' root' : '')}
          style={{ top: (127 - k) * ROW, height: ROW }}
        />,
      );
    }
    return out;
  }, [scaleSteps, root]);

  const keys = useMemo(() => {
    const out = [];
    for (let k = 127; k >= 0; k--) {
      out.push(
        <div
          key={k}
          className={'pr-key' + (isBlackKey(k) ? ' black' : '')}
          style={{ top: (127 - k) * ROW, height: ROW }}
          onPointerDown={() => preview(k)}
          title={midiToName(k)}
        >
          {k % 12 === 0 ? midiToName(k) : ''}
        </div>,
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id, channel?.sound]);

  const beatW = PPQ * zoom;
  const barW = tpb * zoom;
  const snapW = snap * zoom;
  const gridSize = { width, height } as React.CSSProperties;
  const linesBg = {
    width,
    height,
    backgroundImage: [
      `repeating-linear-gradient(to right, rgba(0,0,0,.55) 0 1px, transparent 1px ${barW}px)`,
      `repeating-linear-gradient(to right, rgba(0,0,0,.28) 0 1px, transparent 1px ${beatW}px)`,
      snapW >= 6 ? `repeating-linear-gradient(to right, rgba(0,0,0,.12) 0 1px, transparent 1px ${snapW}px)` : 'none',
    ].join(','),
  } as React.CSSProperties;

  const toolbar = (
    <>
      <div className="seg">
        <button className={tool === 'draw' ? 'on' : ''} onClick={() => setTool('draw')} title="Draw (P)">
          <IconPencil />
        </button>
        <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Select (E) — or Ctrl+drag">
          <IconSelect />
        </button>
        <button className={tool === 'erase' ? 'on' : ''} onClick={() => setTool('erase')} title="Erase (D) — or right-click">
          <IconErase />
        </button>
      </div>
      <label className="tb-label">Snap</label>
      <select value={snapIdx} onChange={(e) => setSnapIdx(+e.target.value)}>
        {SNAPS.map((s, i) => (
          <option key={i} value={i}>
            {s.label}
          </option>
        ))}
      </select>
      <label className="tb-label">Chord</label>
      <select value={chord} onChange={(e) => setChord(e.target.value)} title="Stamp chords while drawing">
        {Object.keys(CHORDS).map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <label className="tb-label">Scale</label>
      <select value={root} onChange={(e) => setRoot(+e.target.value)}>
        {ROOTS.map((r, i) => (
          <option key={r} value={i}>
            {r}
          </option>
        ))}
      </select>
      <select value={scale} onChange={(e) => setScale(e.target.value)}>
        {Object.keys(SCALES).map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <button className={'tb-btn' + (ghosts ? ' on' : '')} onClick={() => setGhosts(!ghosts)} title="Show other channels' notes">
        Ghosts
      </button>
      <button
        className="tb-btn"
        onClick={(e) =>
          openMenuAt(e.currentTarget, [
            { label: 'Quantize starts', shortcut: 'Ctrl+Q', onClick: () => commit(notes.map((n) => ({ ...n, start: Math.round(n.start / snap) * snap }))) },
            { label: 'Quantize starts + lengths', onClick: () => commit(notes.map((n) => ({ ...n, start: Math.round(n.start / snap) * snap, len: Math.max(snap, Math.round(n.len / snap) * snap) }))) },
            { label: 'Transpose +1 octave', onClick: () => commit(notes.map((n) => ((sel.size ? sel.has(n.id) : true) ? { ...n, key: Math.min(127, n.key + 12) } : n))) },
            { label: 'Transpose −1 octave', onClick: () => commit(notes.map((n) => ((sel.size ? sel.has(n.id) : true) ? { ...n, key: Math.max(0, n.key - 12) } : n))) },
            { label: 'Legato (extend to next note)', onClick: () => commit(legato(notes)) },
            { label: 'Arpeggiate chords (up, current snap)', onClick: () => commit(arpeggiate(notes, snap, false)) },
            { label: 'Arpeggiate chords (up-down)', onClick: () => commit(arpeggiate(notes, snap, true)) },
            { label: 'Strum chords', onClick: () => commit(strum(notes, Math.max(4, Math.round(snap / 4)))) },
            { label: 'Humanize velocity', onClick: () => commit(notes.map((n) => ({ ...n, vel: Math.max(0.1, Math.min(1, n.vel + (Math.random() - 0.5) * 0.25)) }))) },
            { label: 'Reverse', onClick: () => commit(reverse(notes, (pattern?.bars ?? 1) * tpb)) },
            { separator: true },
            { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => setSel(new Set(notes.map((n) => n.id))) },
            { label: 'Delete all notes', danger: true, onClick: () => commit([]) },
          ])
        }
      >
        Tools ▾
      </button>
      <label className="tb-label">Channel</label>
      <select value={chId ?? ''} onChange={(e) => useStudio.setState({ channelId: e.target.value })}>
        {project.channels
          .filter((c) => c.kind !== 'code')
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
    </>
  );

  return (
    <Window id="pianoRoll" title={`Piano roll — ${channel?.name ?? 'no channel'} · ${pattern?.name ?? ''}`} toolbar={toolbar} minW={520} minH={260}>
      {!channel || channel.kind === 'code' ? (
        <div className="empty-hint">Select an instrument channel in the channel rack to edit its notes.</div>
      ) : (
        <div className="pr">
          <div className="pr-main">
            <div className="pr-keyboard-wrap" style={{ width: KEYBOARD_W }}>
              <div className="pr-keyboard" ref={keyboard} style={{ height }}>
                {keys}
              </div>
            </div>
            <div className="pr-scroll" ref={scroller} onScroll={onScroll} onWheel={onWheel}>
              <div
                className={'pr-grid tool-' + tool}
                style={gridSize}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={(e) => e.preventDefault()}
              >
                {rows}
                <div className="pr-lines" style={linesBg} />
                <div className="pr-end" style={{ left: bars * tpb * zoom }} />
                {ghostNotes.map((n) => (
                  <div key={'g' + n.id} className="pr-ghost" style={{ left: n.start * zoom, top: (127 - n.key) * ROW, width: Math.max(2, n.len * zoom - 1), height: ROW - 1, borderColor: n.color }} />
                ))}
                {notes.map((n) => (
                  <div
                    key={n.id}
                    className={'pr-note' + (sel.has(n.id) ? ' sel' : '')}
                    style={{
                      left: n.start * zoom,
                      top: (127 - n.key) * ROW,
                      width: Math.max(3, n.len * zoom - 1),
                      height: ROW - 1,
                      background: channel.color,
                      opacity: 0.45 + n.vel * 0.55,
                    }}
                  >
                    {n.len * zoom > 26 && <span>{midiToName(n.key)}</span>}
                  </div>
                ))}
                {box && <div className="pr-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
                <div className="playhead" ref={playhead} style={{ height }} />
              </div>
            </div>
          </div>
          <div className="pr-velocity-wrap" style={{ height: VEL_H, marginLeft: KEYBOARD_W }}>
            <div className="pr-velocity" ref={velLane} style={{ width, height: VEL_H }} onPointerDown={velDown} onPointerMove={velMove} onPointerUp={onPointerUp} title="Velocity: drag bars up/down">
              {notes.map((n) => (
                <i key={n.id} className={sel.has(n.id) ? 'sel' : ''} style={{ left: n.start * zoom, height: `${n.vel * 100}%`, background: channel.color }} />
              ))}
            </div>
          </div>
        </div>
      )}
    </Window>
  );
}

/** turns stacked chords into arpeggios that fill each chord's length */
function arpeggiate(notes: Note[], step: number, upDown: boolean): Note[] {
  const groups = new Map<number, Note[]>();
  for (const n of notes) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
  const out: Note[] = [];
  for (const [start, g] of groups) {
    if (g.length < 2) {
      out.push(...g);
      continue;
    }
    const keys = g.map((n) => n.key).sort((a, b) => a - b);
    const order = upDown ? [...keys, ...keys.slice(1, -1).reverse()] : keys;
    const len = Math.max(...g.map((n) => n.len));
    const vel = g[0].vel;
    for (let t = 0, i = 0; t < len; t += step, i++) {
      out.push({ id: uid('n'), key: order[i % order.length], start: start + t, len: Math.min(step, len - t), vel });
    }
  }
  return out;
}

function strum(notes: Note[], offset: number): Note[] {
  const groups = new Map<number, Note[]>();
  for (const n of notes) groups.set(n.start, [...(groups.get(n.start) ?? []), n]);
  return [...groups.values()].flatMap((g) =>
    [...g].sort((a, b) => a.key - b.key).map((n, i) => ({ ...n, start: n.start + i * offset, len: Math.max(offset, n.len - i * offset) })),
  );
}

function legato(notes: Note[]): Note[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  return sorted.map((n) => {
    const next = sorted.find((m) => m.start > n.start);
    return next ? { ...n, len: next.start - n.start } : n;
  });
}

function reverse(notes: Note[], total: number): Note[] {
  return notes.map((n) => ({ ...n, start: Math.max(0, total - (n.start + n.len)) }));
}
