import { useRef, useState } from 'react';
import { useStudio, getState } from '../../store/store';
import type { MixerInsert, Project } from '../../model/types';
import * as A from '../../store/actions';
import { Window } from '../components/Window';
import { Knob } from '../components/Knob';
import { Meter } from '../components/Meter';
import { openContextMenu, openMenuAt, promptText } from '../components/Menu';
import { EFFECTS, EFFECT_MAP } from '../../plugins/effects';
import { formatParam } from '../../model/paramDefs';
import { PALETTE } from '../../model/util';
import { engine } from '../../engine/engine';
import { useTick } from '../ticker';

const gainToDb = (g: number) => (g <= 0.0001 ? '-∞' : (20 * Math.log10(g)).toFixed(1));
// fader law: position 0..1 -> gain 0..1.25 (≈ +2 dB), 0.8 position = unity
const posToGain = (p: number) => (p <= 0 ? 0 : Math.pow(p / 0.8, 2.2));
const gainToPos = (g: number) => (g <= 0 ? 0 : 0.8 * Math.pow(g, 1 / 2.2));

function Fader({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; p: number } | null>(null);
  const pos = gainToPos(value);
  const H = 130;
  return (
    <div
      className="fader"
      ref={ref}
      style={{ height: H }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, p: pos };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const sens = e.shiftKey ? 4 : 1;
        const p = Math.max(0, Math.min(1, d.p + (d.y - e.clientY) / H / sens));
        onChange(Math.min(1.25, posToGain(p)));
        getState().setHint(`Volume ${gainToDb(posToGain(p))} dB`);
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => onChange(0.8)}
      onWheel={(e) => {
        e.stopPropagation();
        const p = Math.max(0, Math.min(1, pos + (e.deltaY < 0 ? 0.02 : -0.02)));
        onChange(Math.min(1.25, posToGain(p)));
      }}
      title={`${gainToDb(value)} dB — drag / wheel, double-click = 0.8`}
    >
      <div className="fader-track" />
      <div className="fader-unity" style={{ bottom: 0.8 * (H - 16) + 8 }} />
      <div className="fader-cap" style={{ bottom: pos * (H - 16) }} />
    </div>
  );
}

export function Mixer() {
  const project = useStudio((s) => s.project);
  const selected = useStudio((s) => s.selectedInsert);
  const ins = project.mixer[selected] ?? project.mixer[0];
  return (
    <Window id="mixer" title="Mixer" minW={600} minH={300}>
      <div className="mixer">
        <div className="mixer-strips">
          {project.mixer.map((m, i) => (
            <Strip key={m.id} index={i} m={m} project={project} selected={i === selected} />
          ))}
        </div>
        <InsertPanel index={selected} ins={ins} project={project} />
      </div>
    </Window>
  );
}

function Strip({ index, m, project, selected }: { index: number; m: MixerInsert; project: Project; selected: boolean }) {
  const routed = project.channels.filter((c) => c.insert === index);
  const set = (patch: Partial<MixerInsert>, co?: string) => A.setInsert(index, patch, co);
  return (
    <div
      className={'strip' + (selected ? ' sel' : '') + (index === 0 ? ' master' : '') + (m.mute ? ' muted' : '')}
      onPointerDown={() => useStudio.setState({ selectedInsert: index })}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Rename…', onClick: () => promptText('Rename insert', m.name, (v) => v && set({ name: v })) },
          { label: 'Color', submenu: PALETTE.map((c) => ({ label: c, color: c, onClick: () => set({ color: c }) })) },
          { label: 'Reset strip', onClick: () => set({ volume: 0.8, pan: 0, mute: false, solo: false }) },
          { label: 'Clear effects', danger: true, onClick: () => set({ fx: index === 0 ? m.fx.filter((f) => f.pluginId === 'limiter') : [] }) },
        ])
      }
      title={routed.length ? `Channels: ${routed.map((c) => c.name).join(', ')}` : index === 0 ? 'Master output' : 'No channels routed here'}
    >
      <div className="strip-color" style={{ background: m.color }} />
      <div className="strip-name" onDoubleClick={() => promptText('Rename insert', m.name, (v) => v && set({ name: v }))}>
        {index === 0 ? 'Master' : `${index} ${m.name}`}
      </div>
      <div className="strip-fx-dots">
        {m.fx.map((f) => (
          <i key={f.id} className={f.enabled ? 'on' : ''} title={EFFECT_MAP[f.pluginId]?.name} />
        ))}
        {(m.reverb > 0 || m.delay > 0) && <i className="orbit" title="Strudel reverb/delay" />}
        {m.duckTargets.length > 0 && <i className="duck" title={`Sidechain → ${m.duckTargets.join(', ')}`} />}
      </div>
      <Knob size={24} value={m.pan} min={-1} max={1} def={0} bipolar label="" format={(v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`)} onChange={(v) => set({ pan: v }, `ipan:${index}`)} hint="Insert pan" />
      <div className="strip-fader-row">
        <Fader value={m.volume} onChange={(v) => set({ volume: v }, `ivol:${index}`)} />
        <Meter insert={index} height={130} width={12} />
      </div>
      <div className="strip-db">{gainToDb(m.volume)} dB</div>
      <div className="strip-btns">
        <button className={'mute' + (m.mute ? ' on' : '')} onClick={() => set({ mute: !m.mute })} title="Mute">
          M
        </button>
        {index > 0 && (
          <button className={'solo' + (m.solo ? ' on' : '')} onClick={() => set({ solo: !m.solo })} title="Solo">
            S
          </button>
        )}
      </div>
      <div className="strip-routed">{routed.length ? routed.length + ' ch' : ''}</div>
    </div>
  );
}

function InsertPanel({ index, ins, project }: { index: number; ins: MixerInsert; project: Project }) {
  const [open, setOpen] = useState<string | null>(null);
  const set = (patch: Partial<MixerInsert>, co?: string) => A.setInsert(index, patch, co);
  const routed = project.channels.filter((c) => c.insert === index);
  return (
    <div className="insert-panel">
      <div className="ip-head">
        <i style={{ background: ins.color }} />
        <b>{index === 0 ? 'Master' : `Insert ${index}: ${ins.name}`}</b>
      </div>
      <div className="ip-routed">{routed.length ? 'Channels: ' + routed.map((c) => c.name).join(', ') : index === 0 ? 'All inserts feed the master' : 'No channels routed here (set in channel rack)'}</div>

      {index > 0 && (
        <section className="ip-section">
          <h4>Strudel FX (orbit {index})</h4>
          <div className="knob-row">
            <Knob value={ins.reverb} min={0} max={1} def={0} label="Reverb" format={(v) => Math.round(v * 100) + '%'} onChange={(v) => set({ reverb: v }, `rv:${index}`)} hint="room: reverb send" />
            <Knob value={ins.reverbSize} min={0.1} max={10} def={2} curve="exp" label="Size" format={(v) => v.toFixed(1)} onChange={(v) => set({ reverbSize: v }, `rs:${index}`)} hint="roomsize" />
            <Knob value={ins.reverbLp} min={500} max={20000} def={8000} curve="log" label="Rev LP" format={(v) => (v / 1000).toFixed(1) + 'k'} onChange={(v) => set({ reverbLp: v }, `rl:${index}`)} hint="roomlp" />
            <Knob value={ins.delay} min={0} max={1} def={0} label="Delay" format={(v) => Math.round(v * 100) + '%'} onChange={(v) => set({ delay: v }, `dl:${index}`)} hint="delay send" />
            <Knob value={ins.delaySteps} min={1} max={16} step={1} def={3} label="Time" format={(v) => `${Math.round(v)}/16`} onChange={(v) => set({ delaySteps: v }, `dt:${index}`)} hint="delay time in 1/16 steps (tempo synced)" />
            <Knob value={ins.delayFeedback} min={0} max={0.95} def={0.4} label="Feedb." format={(v) => Math.round(v * 100) + '%'} onChange={(v) => set({ delayFeedback: v }, `df:${index}`)} />
            <Knob value={ins.djf} min={0} max={1} def={0.5} bipolar label="DJ Filter" format={(v) => (Math.abs(v - 0.5) < 0.01 ? 'off' : v < 0.5 ? 'LP' : 'HP')} onChange={(v) => set({ djf: v }, `dj:${index}`)} hint="djf: <0.5 low-pass, >0.5 high-pass" />
          </div>
          <div className="duck-row">
            <span title="When channels routed to this insert play, the selected inserts are ducked (sidechain pumping)">Sidechain → duck:</span>
            {project.mixer.map((m, i) =>
              i === 0 || i === index ? null : (
                <label key={m.id} className={'duck-chip' + (ins.duckTargets.includes(i) ? ' on' : '')} title={m.name}>
                  <input
                    type="checkbox"
                    checked={ins.duckTargets.includes(i)}
                    onChange={(e) => set({ duckTargets: e.target.checked ? [...ins.duckTargets, i].sort((a, b) => a - b) : ins.duckTargets.filter((x) => x !== i) })}
                  />
                  {i}
                </label>
              ),
            )}
          </div>
          {ins.duckTargets.length > 0 && (
            <div className="knob-row">
              <Knob value={ins.duckDepth} min={0} max={1} def={0.8} label="Depth" format={(v) => Math.round(v * 100) + '%'} onChange={(v) => set({ duckDepth: v }, `dd:${index}`)} />
              <Knob value={ins.duckRelease} min={0.01} max={1} def={0.15} curve="exp" label="Release" format={(v) => v.toFixed(2) + 's'} onChange={(v) => set({ duckRelease: v }, `dr:${index}`)} />
            </div>
          )}
        </section>
      )}

      <section className="ip-section">
        <h4>
          Effect slots (native)
          <button
            className="tb-btn"
            disabled={ins.fx.length >= 8}
            onClick={(e) =>
              openMenuAt(
                e.currentTarget,
                EFFECTS.map((fx) => ({ label: fx.name, hint: fx.description, onClick: () => A.addFx(index, fx.id) })),
              )
            }
          >
            + Add
          </button>
        </h4>
        {!ins.fx.length && <div className="muted small">No effects. Add EQ, compression, chorus, width, delay, reverb…</div>}
        {ins.fx.map((f, si) => {
          const def = EFFECT_MAP[f.pluginId];
          if (!def) return null;
          const expanded = open === f.id;
          return (
            <div key={f.id} className={'fx-slot' + (f.enabled ? '' : ' off')}>
              <div className="fx-head">
                <button className={'led-btn' + (f.enabled ? ' lit' : '')} onClick={() => A.setFx(index, f.id, { enabled: !f.enabled })} title="Bypass" />
                <span className="fx-name" onClick={() => setOpen(expanded ? null : f.id)}>
                  {expanded ? '▾' : '▸'} {si + 1}. {def.name}
                </span>
                <GR index={index} slotId={f.id} show={f.pluginId === 'compressor' || f.pluginId === 'limiter'} />
                <Knob size={22} value={f.mix} min={0} max={1} def={1} label="" format={(v) => 'Mix ' + Math.round(v * 100) + '%'} onChange={(v) => A.setFx(index, f.id, { mix: v })} hint="Dry / wet mix" />
                <button className="icon-btn" onClick={() => A.moveFx(index, f.id, -1)} title="Move up">
                  ↑
                </button>
                <button className="icon-btn" onClick={() => A.moveFx(index, f.id, 1)} title="Move down">
                  ↓
                </button>
                <button className="icon-btn danger" onClick={() => A.removeFx(index, f.id)} title="Remove">
                  ✕
                </button>
              </div>
              {expanded && (
                <div className="knob-row">
                  {def.params.map((p) => (
                    <Knob
                      key={p.key}
                      value={f.params[p.key] ?? p.def}
                      min={p.min}
                      max={p.max}
                      def={p.def}
                      step={p.step}
                      curve={p.curve}
                      label={p.label}
                      format={(v) => formatParam(p, v)}
                      onChange={(v) => A.setFx(index, f.id, { param: [p.key, v] })}
                      onReset={() => A.setFx(index, f.id, { param: [p.key, undefined] })}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>
      {index === 0 && (
        <section className="ip-section">
          <h4>Master</h4>
          <div className="muted small">The master strip feeds your speakers and the WAV export. A limiter is inserted by default to prevent clipping.</div>
        </section>
      )}
    </div>
  );
}

function GR({ index, slotId, show }: { index: number; slotId: string; show: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTick(() => {
    if (!ref.current) return;
    const r = engine.reduction(index, slotId);
    ref.current.textContent = r < -0.1 ? `GR ${r.toFixed(1)} dB` : '';
  }, show);
  return show ? <span className="gr" ref={ref} /> : null;
}
