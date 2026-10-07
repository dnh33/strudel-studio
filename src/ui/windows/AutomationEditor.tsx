import { useRef, useState } from 'react';
import { useStudio } from '../../store/store';
import type { AutomationPoint, Clip, Project } from '../../model/types';
import * as A from '../../store/actions';
import { Window } from '../components/Window';
import { CHANNEL_CORE_AUTOMATION, CHANNEL_PARAMS, formatParam, fromNorm, type ParamDef } from '../../model/paramDefs';
import { getPlugin } from '../../plugins/registry';

export function automationParams(project: Project, chId: string): ParamDef[] {
  const ch = project.channels.find((c) => c.id === chId);
  if (!ch) return [];
  const plugin = ch.kind === 'plugin' ? getPlugin(ch.sound) : undefined;
  return [
    ...CHANNEL_CORE_AUTOMATION,
    ...CHANNEL_PARAMS.filter((d) => d.automatable && (!d.kinds || d.kinds.includes(ch.kind))),
    ...(plugin?.params.filter((p) => p.automatable).map((p) => ({ ...p, key: 'plugin:' + p.key, label: `${plugin.name}: ${p.label}` })) ?? []),
  ];
}

const W = 1000;
const H = 300;

export function AutomationEditor() {
  const clipId = useStudio((s) => s.automationClipId);
  const project = useStudio((s) => s.project);
  const clip = project.clips.find((c) => c.id === clipId && c.kind === 'automation');
  return (
    <Window id="automation" title={clip ? `Automation — ${clip.automation?.name}` : 'Automation clip'} minW={420} minH={240}>
      {clip ? <Editor clip={clip} project={project} /> : <div className="empty-hint">Right-click a knob (or a channel) → “Create automation clip”, then double-click the clip in the playlist.</div>}
    </Window>
  );
}

function Editor({ clip, project }: { clip: Clip; project: Project }) {
  const auto = clip.automation!;
  const target = auto.target;
  const params = target ? automationParams(project, target.channelId) : [];
  const def = params.find((p) => p.key === target?.param);
  const svg = useRef<SVGSVGElement>(null);
  const [dragI, setDragI] = useState<number | null>(null);
  const co = useRef('auto:' + Date.now());
  const pts = [...auto.points].sort((a, b) => a.x - b.x);

  const setPoints = (points: AutomationPoint[], coalesce?: string) =>
    A.updateClips((clips) => {
      const c = clips.find((x) => x.id === clip.id);
      if (c?.automation) c.automation.points = points.sort((a, b) => a.x - b.x);
    }, coalesce);
  const setAuto = (patch: Partial<NonNullable<Clip['automation']>>) =>
    A.updateClips((clips) => {
      const c = clips.find((x) => x.id === clip.id);
      if (c?.automation) Object.assign(c.automation, patch);
    });

  const toPt = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) };
  };

  const onDown = (e: React.PointerEvent) => {
    const p = toPt(e);
    const r = svg.current!.getBoundingClientRect();
    const near = pts.findIndex((q) => Math.abs(q.x - p.x) * r.width < 8 && Math.abs(q.y - p.y) * r.height < 8);
    if (e.button === 2) {
      if (near >= 0 && pts.length > 1) setPoints(pts.filter((_, i) => i !== near));
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    co.current = 'auto:' + e.timeStamp;
    if (near >= 0) setDragI(near);
    else {
      const next = [...pts, p].sort((a, b) => a.x - b.x);
      setPoints(next, co.current);
      setDragI(next.indexOf(p));
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragI === null) return;
    const p = toPt(e);
    const next = pts.map((q, i) => (i === dragI ? p : q));
    setPoints(next, co.current);
    // keep index stable after sort
    setDragI(next.sort((a, b) => a.x - b.x).indexOf(p));
  };

  const shape = (fn: (x: number) => number, n = 17) => setPoints(Array.from({ length: n }, (_, i) => ({ x: i / (n - 1), y: Math.max(0, Math.min(1, fn(i / (n - 1)))) })));

  const valueLabel = (y: number) => (def ? formatParam(def, fromNorm(def, y)) : (y * 100).toFixed(0) + '%');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x * W} ${(1 - p.y) * H}`).join(' ');

  return (
    <div className="auto-editor">
      <div className="auto-bar">
        <input value={auto.name} onChange={(e) => setAuto({ name: e.target.value })} className="name-input" />
        <label>
          Channel
          <select
            value={target?.channelId ?? ''}
            onChange={(e) => setAuto({ target: { channelId: e.target.value, param: 'volume' } })}
          >
            <option value="">—</option>
            {project.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Parameter
          <select value={target?.param ?? ''} onChange={(e) => target && setAuto({ target: { ...target, param: e.target.value } })}>
            {params.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start
          <input type="number" step={0.25} min={0} value={clip.start + 1} onChange={(e) => A.updateClips((c) => { const x = c.find((y) => y.id === clip.id); if (x) x.start = Math.max(0, +e.target.value - 1); })} />
        </label>
        <label>
          Bars
          <input type="number" step={0.25} min={0.25} value={clip.length} onChange={(e) => A.updateClips((c) => { const x = c.find((y) => y.id === clip.id); if (x) x.length = Math.max(0.25, +e.target.value); })} />
        </label>
      </div>
      <div className="auto-shapes">
        Shapes:
        <button onClick={() => shape((x) => x, 2)}>Ramp up</button>
        <button onClick={() => shape((x) => 1 - x, 2)}>Ramp down</button>
        <button onClick={() => shape((x) => 0.5 + 0.5 * Math.sin(x * Math.PI * 2 * 2))}>Sine ×2</button>
        <button onClick={() => shape((x) => 1 - Math.abs(((x * 4) % 2) - 1), 9)}>Triangle</button>
        <button onClick={() => shape((x) => x * x, 9)}>Exp</button>
        <button onClick={() => shape(() => 0.2 + Math.random() * 0.6, 9)}>Random</button>
        <span className="muted small">click: add point · drag: move · right-click: delete</span>
      </div>
      <svg ref={svg} className="auto-canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setDragI(null)} onContextMenu={(e) => e.preventDefault()}>
        {Array.from({ length: Math.max(1, Math.round(clip.length)) + 1 }, (_, i) => (
          <line key={i} x1={(i / Math.max(1, clip.length)) * W} x2={(i / Math.max(1, clip.length)) * W} y1={0} y2={H} className="auto-grid" />
        ))}
        {[0.25, 0.5, 0.75].map((y) => (
          <line key={y} x1={0} x2={W} y1={y * H} y2={y * H} className="auto-grid" />
        ))}
        <path d={`${path} L ${W} ${(1 - (pts[pts.length - 1]?.y ?? 0)) * H} L ${W} ${H} L 0 ${H} L 0 ${(1 - (pts[0]?.y ?? 0)) * H} Z`} className="auto-fill" />
        <path d={path} className="auto-line" vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x * W} cy={(1 - p.y) * H} r={7} className={'auto-pt' + (dragI === i ? ' on' : '')} vectorEffect="non-scaling-stroke" />
            {dragI === i && (
              <text x={Math.min(W - 120, p.x * W + 10)} y={Math.max(16, (1 - p.y) * H - 10)} className="auto-label">
                {valueLabel(p.y)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="auto-range muted small">
        {def ? `Range ${formatParam(def, def.min)} … ${formatParam(def, def.max)}` : 'Choose a target parameter'} · plays in Song mode · compiled to <code>.{def?.control ?? 'param'}(curve(…))</code>
      </div>
    </div>
  );
}
