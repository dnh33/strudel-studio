import { useRef, type ReactNode } from 'react';
import { useStudio, WINDOW_TITLES, type WindowId } from '../../store/store';

interface Props {
  id: WindowId;
  title?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  minW?: number;
  minH?: number;
}

export function Window({ id, title, toolbar, children, minW = 280, minH = 140 }: Props) {
  const w = useStudio((s) => s.windows[id]);
  const isTop = useStudio((s) => s.windows[id].z === s.zTop);
  const { moveWindow, focusWindow, openWindow } = useStudio.getState();
  const drag = useRef<{ mx: number; my: number; x: number; y: number; w: number; h: number; mode: 'move' | 'resize' } | null>(null);
  if (!w.open) return null;

  const begin = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('button, input, select, textarea, label, .knob, .seg, .pattern-picker')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mx: e.clientX, my: e.clientY, x: w.x, y: w.y, w: w.w, h: w.h, mode };
    focusWindow(id);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.mx;
    const dy = e.clientY - d.my;
    if (d.mode === 'move') moveWindow(id, { x: Math.max(-d.w + 80, d.x + dx), y: Math.max(0, d.y + dy), max: false });
    else moveWindow(id, { w: Math.max(minW, d.w + dx), h: Math.max(minH, d.h + dy), max: false });
  };
  const end = () => (drag.current = null);

  const style: React.CSSProperties = w.max
    ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: w.z }
    : { left: w.x, top: w.y, width: w.w, height: w.h, zIndex: w.z };

  return (
    <section className={'win' + (isTop ? ' top' : '')} style={style} onPointerDownCapture={() => focusWindow(id)} data-window={id}>
      <header
        className="win-title"
        onPointerDown={(e) => begin(e, 'move')}
        onPointerMove={move}
        onPointerUp={end}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button, input, select')) return;
          moveWindow(id, { max: !w.max });
        }}
      >
        <span className="win-name">{title ?? WINDOW_TITLES[id]}</span>
        <div className="win-toolbar">{toolbar}</div>
        <button className="win-btn" title="Maximize / restore" onClick={() => moveWindow(id, { max: !w.max })}>
          {w.max ? '❐' : '□'}
        </button>
        <button className="win-btn close" title="Close" onClick={() => openWindow(id, false)}>
          ✕
        </button>
      </header>
      <div className="win-body">{children}</div>
      {!w.max && <div className="win-resize" onPointerDown={(e) => begin(e, 'resize')} onPointerMove={move} onPointerUp={end} />}
    </section>
  );
}
