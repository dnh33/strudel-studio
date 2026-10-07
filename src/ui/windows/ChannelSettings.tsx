import { useEffect, useMemo, useRef } from 'react';
import type { EditorView } from '@codemirror/view';
import { initEditor } from '@strudel/codemirror';
import { useStudio, getState } from '../../store/store';
import type { Channel, Project } from '../../model/types';
import * as A from '../../store/actions';
import { Window } from '../components/Window';
import { Knob } from '../components/Knob';
import { openContextMenu, openMenuAt } from '../components/Menu';
import { CHANNEL_PARAMS, PARAM_GROUPS, formatParam, type ParamDef } from '../../model/paramDefs';
import { engine } from '../../engine/engine';
import { GM_SOUNDFONTS, SYNTHS } from '../../engine/library';
import { getInstalledPlugins, getPlugin, onPluginsChanged } from '../../plugins/registry';
import { midiToName } from '../../model/util';
import { useSyncExternalStore } from 'react';
import { openPianoRoll, vstInstrumentMenu } from './ChannelRack';
import { isNative, useNative, openEditor } from '../../native/nativeStudio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let pluginTick = 0;
onPluginsChanged(() => pluginTick++);
const usePluginsVersion = () =>
  useSyncExternalStore(
    (cb) => onPluginsChanged(cb) as unknown as () => void,
    () => pluginTick,
  );

const CODE_EXAMPLES = [
  'n("0 2 4 <7 9>").scale("C4:minor").s("triangle")',
  's("hh*8").gain("[.4 .8]*4")',
  'note("<c3 eb3 g2 bb2>").s("sawtooth").lpf(sine.range(300, 2000).slow(4))',
  's("bd*2, ~ sd, [~ hh]*2").bank("RolandTR808")',
  'n(run(8)).scale("A3:minor").s("pluck").sometimes(x => x.add(note(12)))',
  'chord("<Am7 Dm7 G7 Cmaj7>").voicing().s("gm_epiano1")',
];

export function ChannelSettings() {
  const chId = useStudio((s) => s.settingsChannelId);
  const project = useStudio((s) => s.project);
  const ch = project.channels.find((c) => c.id === chId);
  return (
    <Window id="channelSettings" title={ch ? `Channel settings — ${ch.name}` : 'Channel settings'} minW={420} minH={300}>
      {ch ? <SettingsBody ch={ch} project={project} /> : <div className="empty-hint">Double-click a channel in the channel rack to edit it.</div>}
    </Window>
  );
}

function SettingsBody({ ch, project }: { ch: Channel; project: Project }) {
  usePluginsVersion();
  const set = (patch: Partial<Channel>, co?: string) => A.setChannel(ch.id, patch, co);
  const groups = PARAM_GROUPS.map((g) => ({ g, params: CHANNEL_PARAMS.filter((p) => p.group === g && (!p.kinds || p.kinds.includes(ch.kind))) })).filter((x) => x.params.length);
  const preview = () => engine.previewChannel(getState().project, ch);
  const plugin = ch.kind === 'plugin' ? getPlugin(ch.sound) : undefined;

  return (
    <div className="settings">
      <div className="settings-head">
        <input className="name-input" value={ch.name} onChange={(e) => set({ name: e.target.value }, `name:${ch.id}`)} style={{ borderLeftColor: ch.color }} />
        <select value={ch.kind} onChange={(e) => set({ kind: e.target.value as Channel['kind'], sound: defaultSound(e.target.value as Channel['kind']) })} title="Channel type">
          <option value="sample">Sampler</option>
          <option value="synth">Synth</option>
          <option value="soundfont">Soundfont</option>
          <option value="plugin">Plugin (Strudel JS)</option>
          <option value="code">Code</option>
          {(isNative || ch.kind === 'vst') && <option value="vst">VST3 plug-in (native)</option>}
        </select>
        <label className="tb-label">Insert</label>
        <select value={ch.insert} onChange={(e) => set({ insert: +e.target.value })}>
          {project.mixer.map((m, i) => (
            <option key={m.id} value={i}>
              {i === 0 ? 'Master' : `${i} · ${m.name}`}
            </option>
          ))}
        </select>
        <button className="tb-btn primary" onClick={preview}>
          ▶ Preview
        </button>
        {ch.kind !== 'code' && (
          <button className="tb-btn" onClick={() => openPianoRoll(ch.id)}>
            Piano roll
          </button>
        )}
      </div>

      <div className="knob-row">
        <Knob value={ch.volume} min={0} max={1.5} def={0.8} label="Volume" format={(v) => Math.round(v * 100) + '%'} onChange={(v) => set({ volume: v }, `vol:${ch.id}`)} onContextMenu={(e) => autoMenu(e, ch, 'volume')} />
        <Knob value={ch.pan} min={0} max={1} def={0.5} bipolar label="Pan" format={(v) => (Math.abs(v - 0.5) < 0.005 ? 'C' : v < 0.5 ? `${Math.round((0.5 - v) * 200)}L` : `${Math.round((v - 0.5) * 200)}R`)} onChange={(v) => set({ pan: v }, `pan:${ch.id}`)} onContextMenu={(e) => autoMenu(e, ch, 'pan')} />
        {ch.kind !== 'code' && (
          <Knob value={ch.rootNote} min={24} max={96} step={1} def={ch.kind === 'sample' ? 36 : 60} label="Step note" format={(v) => midiToName(Math.round(v))} onChange={(v) => set({ rootNote: Math.round(v) }, `root:${ch.id}`)} hint="Note played by channel-rack steps" />
        )}
      </div>

      <SoundSection ch={ch} set={set} />

      {plugin && plugin.params.length > 0 && (
        <section className="settings-group">
          <h4>
            {plugin.name} <span className="muted small">{plugin.description}</span>
          </h4>
          <div className="knob-row">
            {plugin.params.map((p) =>
              p.optionLabels ? (
                <label key={p.key} className="opt-param">
                  <span>{p.label}</span>
                  <select value={Math.round(ch.pluginParams[p.key] ?? p.def)} onChange={(e) => A.setPluginParam(ch.id, p.key, +e.target.value)}>
                    {p.optionLabels.map((o, i) => (
                      <option key={o} value={i}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <Knob
                  key={p.key}
                  value={ch.pluginParams[p.key] ?? p.def}
                  inactive={ch.pluginParams[p.key] === undefined}
                  min={p.min}
                  max={p.max}
                  def={p.def}
                  step={p.step}
                  curve={p.curve}
                  label={p.label}
                  color={ch.color}
                  format={(v) => formatParam(p, v)}
                  onChange={(v) => A.setPluginParam(ch.id, p.key, v)}
                  onReset={() => A.setPluginParam(ch.id, p.key, undefined)}
                  onContextMenu={(e) => autoMenu(e, ch, 'plugin:' + p.key)}
                />
              ),
            )}
          </div>
        </section>
      )}

      {groups.map(({ g, params }) => (
        <section key={g} className="settings-group">
          <h4>{g}</h4>
          <div className="knob-row">
            {params.map((p) => (
              <ParamControl key={p.key} p={p} ch={ch} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function defaultSound(kind: Channel['kind']) {
  return kind === 'synth' ? 'sawtooth' : kind === 'soundfont' ? 'gm_piano' : kind === 'plugin' ? 'triosc' : kind === 'sample' ? 'bd' : '';
}

function autoMenu(e: React.MouseEvent, ch: Channel, param: string) {
  openContextMenu(e, [
    {
      label: 'Create automation clip',
      onClick: () => {
        const p = getState().project;
        let track = 0;
        for (let i = p.tracks.length - 1; i >= 0; i--) if (p.clips.some((c) => c.track === i)) { track = Math.min(p.tracks.length - 1, i + 1); break; }
        A.addAutomationClip(ch.id, param, getState().startBar, track);
      },
    },
  ]);
}

function ParamControl({ p, ch }: { p: ParamDef; ch: Channel }) {
  const v = ch.params[p.key];
  if (p.options) {
    return (
      <label className="opt-param">
        <span>{p.label}</span>
        <select value={Math.round(v ?? p.def)} onChange={(e) => A.setChannelParam(ch.id, p.key, +e.target.value === p.def ? undefined : +e.target.value)}>
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <Knob
      value={v ?? p.def}
      inactive={v === undefined}
      min={p.min}
      max={p.max}
      def={p.def}
      step={p.step}
      curve={p.curve}
      label={p.label}
      hint={p.hint}
      color={ch.color}
      bipolar={p.min < 0}
      format={(x) => formatParam(p, x)}
      onChange={(x) => A.setChannelParam(ch.id, p.key, x)}
      onReset={() => A.setChannelParam(ch.id, p.key, undefined)}
      onContextMenu={p.automatable ? (e) => autoMenu(e, ch, p.key) : undefined}
    />
  );
}

function SoundSection({ ch, set }: { ch: Channel; set: (p: Partial<Channel>, co?: string) => void }) {
  const maps = engine.sampleMaps;
  const drum = maps['tidal-drum-machines.json'] ?? {};
  const banks = useMemo(() => [...new Set(Object.keys(drum).filter((k) => !k.startsWith('_')).map((k) => k.split('_')[0]))].sort(), [drum]);
  const allSamples = useMemo(() => {
    const names = new Set<string>();
    for (const [file, m] of Object.entries(maps)) {
      if (file === 'tidal-drum-machines.json') continue;
      Object.keys(m).forEach((k) => !k.startsWith('_') && names.add(k));
    }
    engine.userSamples.forEach((u) => names.add(u.name));
    return [...names].sort();
  }, [maps]);
  const bankSounds = useMemo(() => (ch.bank ? Object.keys(drum).filter((k) => k.startsWith(ch.bank + '_')).map((k) => k.slice(ch.bank.length + 1)) : []), [drum, ch.bank]);
  const count = (() => {
    const key = ch.bank ? `${ch.bank}_${ch.sound}` : ch.sound;
    for (const m of Object.values(maps)) if (Array.isArray(m[key])) return m[key].length;
    return 0;
  })();

  if (ch.kind === 'code') return <CodeEditor ch={ch} />;
  if (ch.kind === 'vst') return <VstPanel ch={ch} />;
  return (
    <section className="settings-group">
      <h4>Sound</h4>
      <div className="sound-row">
        {ch.kind === 'sample' && (
          <>
            <label>
              Bank
              <select value={ch.bank} onChange={(e) => set({ bank: e.target.value, n: 0, sound: e.target.value && !Object.keys(drum).includes(`${e.target.value}_${ch.sound}`) ? 'bd' : ch.sound })}>
                <option value="">(no bank — sample folders)</option>
                {banks.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <label>
              Sound
              {ch.bank ? (
                <select value={ch.sound} onChange={(e) => set({ sound: e.target.value, n: 0 })}>
                  {bankSounds.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <>
                  <input list="all-samples" value={ch.sound} onChange={(e) => set({ sound: e.target.value.trim() }, `snd:${ch.id}`)} />
                  <datalist id="all-samples">
                    {allSamples.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </>
              )}
            </label>
            <label>
              Variation
              <input type="number" min={0} max={Math.max(0, count - 1)} value={ch.n} onChange={(e) => set({ n: Math.max(0, +e.target.value || 0) }, `n:${ch.id}`)} />
              <span className="muted small">{count ? `of ${count}` : ''}</span>
            </label>
          </>
        )}
        {ch.kind === 'synth' && (
          <label>
            Waveform
            <select value={ch.sound} onChange={(e) => set({ sound: e.target.value })}>
              {SYNTHS.map((s) => (
                <option key={s.sound} value={s.sound}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {ch.kind === 'soundfont' && (
          <>
            <label>
              Instrument
              <select value={ch.sound} onChange={(e) => set({ sound: e.target.value, n: 0 })}>
                {GM_SOUNDFONTS.map((s) => (
                  <option key={s.sound} value={s.sound}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Font variant
              <input type="number" min={0} max={12} value={ch.n} onChange={(e) => set({ n: Math.max(0, +e.target.value || 0) }, `n:${ch.id}`)} />
            </label>
          </>
        )}
        {ch.kind === 'plugin' && (
          <label>
            Plugin
            <select value={ch.sound} onChange={(e) => set({ sound: e.target.value, pluginParams: {} })}>
              {getInstalledPlugins().map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.stock ? '' : '(user)'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </section>
  );
}

function CodeEditor({ ch }: { ch: Channel }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const err = useStudio((s) => s.codeErrors[ch.id]);
  const patternId = useStudio((s) => s.patternId);
  const enabled = useStudio((s) => !!s.project.patterns.find((p) => p.id === s.patternId)?.code[ch.id]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(ch.id);
  idRef.current = ch.id;

  useEffect(() => {
    if (!host.current) return;
    const v = initEditor({
      root: host.current,
      initialCode: ch.code,
      onChange: (u: Any) => {
        if (!u.docChanged) return;
        const code = u.state.doc.toString();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => A.setChannel(idRef.current, { code }, `code:${idRef.current}`), 350);
      },
      onEvaluate: () => {
        const code = v.state.doc.toString();
        A.setChannel(idRef.current, { code });
        engine.previewChannel(getState().project, { ...ch, code });
      },
      onStop: () => undefined,
    }) as EditorView;
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.id]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== ch.code && !timer.current) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ch.code } });
    timer.current = null;
  }, [ch.code]);

  return (
    <section className="settings-group">
      <h4>
        Strudel code
        <button className={'code-toggle' + (enabled ? ' on' : '')} onClick={() => A.setCodeEnabled(patternId, ch.id, !enabled)}>
          {enabled ? '● playing in this pattern' : '○ off in this pattern'}
        </button>
      </h4>
      <div className="muted small">Any Strudel pattern expression. It is placed in patterns like any other channel and gets this channel's volume, pan, FX and mixer insert. Ctrl+Enter previews one cycle.</div>
      <div className="cm-host small-editor" ref={host} />
      {err && <div className="eval-error">⚠ {err}</div>}
      <div className="examples">
        Examples:
        {CODE_EXAMPLES.map((c) => (
          <code key={c} onClick={() => A.setChannel(ch.id, { code: c })} title="Use this example">
            {c}
          </code>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ VST3 (native app)
function SlotStatus({ st }: { st?: { loaded: boolean; error: string; latency: number } | null }) {
  if (!st) return <span className="muted small">…</span>;
  if (!st.loaded) return <span className="vst-err" title={st.error}>⚠ {st.error || 'not loaded'}</span>;
  return <span className="vst-ok">● loaded{st.latency ? ` · ${st.latency} smp latency` : ''}</span>;
}

function VstPanel({ ch }: { ch: Channel }) {
  const status = useNative((s) => s.status[ch.id]);
  const plugins = useNative((s) => s.plugins);
  const editors = useNative((s) => s.editors);
  const vst = ch.vst;
  if (!isNative) {
    return (
      <section className="settings-group">
        <h4>VST3 instrument</h4>
        <p className="muted">
          This channel hosts the VST3 plug-in <b>{vst?.name ?? '(none)'}</b>
          {vst?.fx.length ? ` with ${vst.fx.length} effect${vst.fx.length > 1 ? 's' : ''}` : ''}. VST3 plug-ins run in the Strudel Studio
          native app — in the browser a simple triangle synth stands in so you can still hear the part.
        </p>
      </section>
    );
  }
  const effects = plugins.filter((p) => !p.isInstrument);
  const fxMenu = (e: React.MouseEvent<HTMLElement>) =>
    openMenuAt(
      e.currentTarget,
      effects.length
        ? effects.map((p) => ({ label: p.name, hint: `${p.vendor} · ${p.category}`, onClick: () => A.addVstFx(ch.id, p) }))
        : [{ label: 'No VST3 effects found — scan in the Audio menu', disabled: true }],
    );
  const known = (id: string) => plugins.some((p) => p.id === id);
  return (
    <section className="settings-group vst-panel">
      <h4>VST3 instrument</h4>
      <div className="vst-slot main">
        <div className="vst-name">
          <b>{vst?.name ?? 'No instrument'}</b>
          {vst?.vendor ? <span className="muted small"> · {vst.vendor}</span> : null}
          <div>{vst ? <SlotStatus st={status?.instrument} /> : <span className="muted small">choose an instrument →</span>}</div>
          {vst && !known(vst.pluginId) && plugins.length > 0 && <div className="vst-err small">Not installed on this computer (the state is kept)</div>}
        </div>
        <div className="vst-buttons">
          <button className={'tb-btn primary' + (editors[`${ch.id}|inst`] ? ' on' : '')} disabled={!status?.instrument?.loaded} onClick={() => openEditor(ch, 'inst')}>
            Show editor
          </button>
          <button className="tb-btn" disabled={!status?.instrument?.loaded} onClick={() => openEditor(ch, 'inst', true)} title="Plain parameter list">
            Params
          </button>
          <button className="tb-btn" onClick={(e) => openMenuAt(e.currentTarget, vstInstrumentMenu((p) => A.setVstInstrument(ch.id, p), 'Choose instrument').submenu ?? [{ label: 'No VST3 instruments found — scan in the Audio menu', disabled: true }])}>
            {vst ? 'Change…' : 'Choose…'}
          </button>
        </div>
      </div>

      <h4>
        Effect chain <span className="muted small">VST3 effects, top to bottom · then volume/pan → the app's audio output</span>
      </h4>
      {!vst?.fx.length && <div className="muted small pad">No effects.</div>}
      {vst?.fx.map((f, i) => {
        const st = status?.fx.find((x) => x.slot === f.id);
        return (
          <div key={f.id} className={'vst-slot' + (f.bypass ? ' bypassed' : '')}>
            <span className="vst-idx">{i + 1}</span>
            <div className="vst-name">
              {f.name}
              <div>
                <SlotStatus st={st} />
              </div>
            </div>
            <div className="vst-buttons">
              <button className={'tb-btn' + (f.bypass ? '' : ' on')} onClick={() => A.setVstFxBypass(ch.id, f.id, !f.bypass)} title="Enable / bypass">
                {f.bypass ? 'Off' : 'On'}
              </button>
              <button className="tb-btn" disabled={!st?.loaded} onClick={() => openEditor(ch, f.id)}>
                Editor
              </button>
              <button className="icon-btn" disabled={i === 0} onClick={() => A.moveVstFx(ch.id, f.id, -1)} title="Move up">
                ↑
              </button>
              <button className="icon-btn" disabled={i === vst.fx.length - 1} onClick={() => A.moveVstFx(ch.id, f.id, 1)} title="Move down">
                ↓
              </button>
              <button className="icon-btn danger" onClick={() => A.removeVstFx(ch.id, f.id)} title="Remove">
                ✕
              </button>
            </div>
          </div>
        );
      })}
      <div className="vst-add">
        <button className="tb-btn" disabled={!vst} onClick={fxMenu}>
          + Add effect
        </button>
        <span className="muted small">
          Tip: VST3 channels don't pass through the Strudel mixer effects — the insert's volume, pan and mute still apply.
        </span>
      </div>
    </section>
  );
}
