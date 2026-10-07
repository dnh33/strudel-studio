import { useRef, useState } from 'react';
import { fromNorm, toNorm, type Curve } from '../../model/paramDefs';
import { useStudio } from '../../store/store';

export interface KnobProps {
  value: number;
  min: number;
  max: number;
  def?: number;
  curve?: Curve;
  step?: number;
  label?: string;
  size?: number;
  color?: string;
  bipolar?: boolean;
  /** true when the value is "unset" (shown dimmed) */
  inactive?: boolean;
  format?: (v: number) => string;
  hint?: string;
  onChange: (v: number) => void;
  onReset?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function Knob(props: KnobProps) {
  const { value, min, max, curve, step, label, size = 34, color = 'var(--accent)', bipolar, inactive, format, hint } = props;
  const def = props.def ?? min;
  const [drag, setDrag] = useState(false);
  const start = useRef({ y: 0, n: 0 });
  const setHint = useStudio((s) => s.setHint);
  const n = toNorm({ min, max, curve }, value);
  const text = format ? format(value) : String(Math.round(value * 100) / 100);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, n };
    setDrag(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dy = start.current.y - e.clientY;
    const sens = e.shiftKey || e.ctrlKey ? 600 : 160;
    const nn = Math.max(0, Math.min(1, start.current.n + dy / sens));
    props.onChange(fromNorm({ min, max, curve, step }, nn));
    setHint(`${label ?? ''}: ${format ? format(fromNorm({ min, max, curve, step }, nn)) : ''}`);
  };
  const onPointerUp = () => setDrag(false);
  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const d = e.deltaY < 0 ? 1 : -1;
    const inc = step ? step / (max - min) : e.shiftKey ? 0.005 : 0.02;
    props.onChange(fromNorm({ min, max, curve, step }, Math.max(0, Math.min(1, n + d * Math.max(inc, 0.001)))));
  };

  // arc
  const a0 = -135;
  const a1 = 135;
  const ang = a0 + (a1 - a0) * n;
  const r = size / 2 - 3;
  const c = size / 2;
  const pt = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)];
  };
  const arc = (from: number, to: number) => {
    const [x0, y0] = pt(from);
    const [x1, y1] = pt(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
  };
  const zero = bipolar ? a0 + (a1 - a0) * toNorm({ min, max, curve }, 0) : a0;
  const [px, py] = pt(ang);

  return (
    <div
      className={'knob' + (inactive ? ' inactive' : '') + (drag ? ' dragging' : '')}
      onMouseEnter={() => setHint(`${label ?? ''}${hint ? ' — ' + hint : ''}: ${text}   (drag, wheel, shift = fine, double-click = reset)`)}
      onContextMenu={props.onContextMenu}
      title={`${label ?? ''}: ${text}`}
    >
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => (props.onReset ? props.onReset() : props.onChange(def))}
        onWheel={onWheel}
        style={{ touchAction: 'none' }}
      >
        <circle cx={c} cy={c} r={r - 3} className="knob-body" />
        <path d={arc(a0, a1)} className="knob-track" />
        {Math.abs(ang - zero) > 0.5 && <path d={arc(Math.min(zero, ang), Math.max(zero, ang))} stroke={color} className="knob-value" />}
        <line x1={c} y1={c} x2={px} y2={py} className="knob-pointer" />
      </svg>
      {label && <div className="knob-label">{label}</div>}
      {drag && <div className="knob-readout">{text}</div>}
    </div>
  );
}
