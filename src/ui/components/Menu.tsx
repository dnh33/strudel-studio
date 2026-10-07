import { create } from 'zustand';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label?: string;
  hint?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  color?: string;
  submenu?: MenuItem[];
  onClick?: () => void;
}

interface MenuState {
  items: MenuItem[] | null;
  x: number;
  y: number;
  open: (items: MenuItem[], x: number, y: number) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  items: null,
  x: 0,
  y: 0,
  open: (items, x, y) => set({ items, x, y }),
  close: () => set({ items: null }),
}));

export function openContextMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.getState().open(items, e.clientX, e.clientY);
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  useMenu.getState().open(items, r.left, r.bottom + 2);
}

function MenuList({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (r.right > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - r.width - 4);
    if (r.bottom > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className={'menu-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '')}
            onMouseEnter={() => setSub(it.submenu ? i : null)}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled || it.submenu) return;
              onDone();
              it.onClick?.();
            }}
            title={it.hint}
          >
            <span className="menu-check">{it.checked ? '✓' : it.color ? <i style={{ background: it.color }} className="menu-swatch" /> : ''}</span>
            <span className="menu-label">{it.label}</span>
            <span className="menu-shortcut">{it.shortcut ?? (it.submenu ? '▸' : '')}</span>
            {it.submenu && sub === i && <SubMenu items={it.submenu} onDone={onDone} />}
          </div>
        ),
      )}
    </div>
  );
}

function SubMenu({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const p = ref.current?.parentElement?.getBoundingClientRect();
    if (p) setPos({ x: p.right - 2, y: p.top - 4 });
  }, []);
  return <span ref={ref}>{pos && <MenuList items={items} x={pos.x} y={pos.y} onDone={onDone} />}</span>;
}

export function MenuHost() {
  const { items, x, y, close } = useMenu();
  useEffect(() => {
    if (!items) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [items, close]);
  if (!items) return null;
  return <MenuList items={items} x={x} y={y} onDone={close} />;
}

// ---------------------------------------------------------------- dialogs
interface DialogState {
  content: ReactNode | null;
  show: (c: ReactNode) => void;
  close: () => void;
}
export const useDialog = create<DialogState>((set) => ({
  content: null,
  show: (content) => set({ content }),
  close: () => set({ content: null }),
}));

export function DialogHost() {
  const { content, close } = useDialog();
  useEffect(() => {
    if (!content) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [content, close]);
  if (!content) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog">{content}</div>
    </div>
  );
}

/** simple text prompt */
export function promptText(title: string, initial: string, onOk: (v: string) => void) {
  const Prompt = () => {
    const [v, setV] = useState(initial);
    const ok = () => {
      useDialog.getState().close();
      onOk(v);
    };
    return (
      <div className="prompt">
        <h3>{title}</h3>
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} onFocus={(e) => e.target.select()} />
        <div className="dialog-buttons">
          <button onClick={() => useDialog.getState().close()}>Cancel</button>
          <button className="primary" onClick={ok}>
            OK
          </button>
        </div>
      </div>
    );
  };
  useDialog.getState().show(<Prompt />);
}

export function confirmDialog(title: string, message: string, onOk: () => void, okLabel = 'OK') {
  useDialog.getState().show(
    <div className="prompt">
      <h3>{title}</h3>
      <p>{message}</p>
      <div className="dialog-buttons">
        <button onClick={() => useDialog.getState().close()}>Cancel</button>
        <button
          className="primary"
          onClick={() => {
            useDialog.getState().close();
            onOk();
          }}
        >
          {okLabel}
        </button>
      </div>
    </div>,
  );
}
