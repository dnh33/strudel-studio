import { useEffect, useRef, useState } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { initEditor } from '@strudel/codemirror';
import { useStudio, getState } from '../../store/store';
import { Window } from '../components/Window';
import { PLUGIN_TEMPLATE } from '../../plugins/sdk';
import { getInstalledPlugins, installPlugin, onPluginsChanged, evaluatePluginSource } from '../../plugins/registry';
import { STOCK_PLUGINS } from '../../plugins/instruments';
import { engine } from '../../engine/engine';
import { analyzeBuffer } from '../../engine/wav';
import * as A from '../../store/actions';
import { createEmptyProject } from '../../model/factory';
import { confirmDialog } from '../components/Menu';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface TestResult {
  ok: boolean;
  message: string;
  peaks?: number[];
}

export function PluginLab() {
  const project = useStudio((s) => s.project);
  const [selected, setSelected] = useState<string>('new');
  const [status, setStatus] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => onPluginsChanged(() => force((x) => x + 1)) as unknown as () => void, []);

  const stock = STOCK_PLUGINS.find((p) => p.id === selected);
  const user = project.userPlugins.find((p) => p.id === selected);
  const source = stock?.source ?? user?.source ?? PLUGIN_TEMPLATE;
  const readOnly = !!stock;

  useEffect(() => {
    if (!host.current) return;
    const v = initEditor({ root: host.current, initialCode: source, onChange: () => undefined, onEvaluate: () => install(), onStop: () => undefined }) as EditorView;
    if (readOnly) v.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    view.current = v;
    setStatus(null);
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const currentSource = () => view.current?.state.doc.toString() ?? source;

  const install = async (): Promise<string | null> => {
    await engine.init();
    const src = currentSource();
    try {
      const defs = evaluatePluginSource(src);
      const def = defs[0];
      if (!def) throw new Error('No definePlugin({...}) call found');
      if (STOCK_PLUGINS.some((p) => p.id === def.id)) throw new Error(`"${def.id}" is a stock plugin id — pick another id`);
      installPlugin(src, false);
      A.setProjectField('userPlugins', [...getState().project.userPlugins.filter((p) => p.id !== def.id && p.id !== selected), { id: def.id, name: def.name ?? def.id, source: src }]);
      setSelected(def.id);
      setStatus({ ok: true, message: `Installed "${def.name ?? def.id}" as sound "${def.id}". Use it as a channel or in code: note("c3 e3 g3").s("${def.id}")` });
      return def.id;
    } catch (e: Any) {
      setStatus({ ok: false, message: 'Error: ' + (e?.message ?? e) });
      return null;
    }
  };

  const test = async () => {
    let id = stock?.id ?? null;
    if (!stock) id = await install();
    if (!id) return;
    setBusy(true);
    try {
      const p = createEmptyProject('plugin-test');
      const buf = await engine.renderBuffer({
        code: `setcpm(30)\n$: note("c3 e3 g3 [c4,e4,g4]").s("${id}").orbit(0)`,
        project: p,
        startBar: 0,
        bars: 1,
        tailSeconds: 1.5,
      });
      const a = analyzeBuffer(buf);
      const d = buf.getChannelData(0);
      const n = 120;
      const peaks = Array.from({ length: n }, (_, i) => {
        let m = 0;
        const from = Math.floor((i / n) * d.length);
        const to = Math.floor(((i + 1) / n) * d.length);
        for (let j = from; j < to; j++) m = Math.max(m, Math.abs(d[j]));
        return m;
      });
      const ok = a.peak > 0.001 && isFinite(a.rms);
      setStatus({
        ok,
        message: ok
          ? `✓ Offline render OK — peak ${a.peakDb.toFixed(1)} dBFS, RMS ${a.rmsDb.toFixed(1)} dBFS (${buf.duration.toFixed(1)}s). Playing it now…`
          : `✗ Render produced silence — check that voice() connects to the returned node and starts its sources.`,
        peaks,
      });
      if (ok) engine.previewSound({ s: id, note: 'c3' }, 0.5);
    } catch (e: Any) {
      setStatus({ ok: false, message: 'Render failed: ' + (e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const plugins = getInstalledPlugins();
  const toolbar = (
    <>
      {!readOnly && (
        <button className="tb-btn primary" onClick={() => install()} title="Ctrl+Enter">
          Install / Update
        </button>
      )}
      <button className="tb-btn" onClick={test} disabled={busy}>
        {busy ? 'Rendering…' : 'Test (render)'}
      </button>
      {plugins.some((p) => p.id === (stock?.id ?? user?.id)) && (
        <button className="tb-btn" onClick={() => A.addChannel({ kind: 'plugin', name: stock?.name ?? user?.name ?? 'Plugin', sound: (stock?.id ?? user?.id)! })}>
          + Add to channel rack
        </button>
      )}
      {readOnly && (
        <button
          className="tb-btn"
          onClick={() => {
            const copy = source.replace(/id:\s*'([a-z0-9]+)'/, "id: '$1copy'").replace(/name:\s*'([^']+)'/, "name: '$1 (copy)'");
            A.setProjectField('userPlugins', [...getState().project.userPlugins, { id: `${stock!.id}copy`, name: `${stock!.name} (copy)`, source: copy }]);
            setSelected(`${stock!.id}copy`);
          }}
        >
          Duplicate to edit
        </button>
      )}
      {user && (
        <button
          className="tb-btn danger"
          onClick={() =>
            confirmDialog('Remove plugin', `Remove "${user.name}" from this project? Channels using it will go silent.`, () => {
              A.setProjectField('userPlugins', getState().project.userPlugins.filter((p) => p.id !== user.id));
              setSelected('new');
            })
          }
        >
          Remove
        </button>
      )}
    </>
  );

  return (
    <Window id="pluginLab" title="Plugin Lab — write instruments (“VSTs”) for Strudel" toolbar={toolbar} minW={600} minH={360}>
      <div className="lab">
        <div className="lab-list">
          <div className="lab-title">Stock instruments</div>
          {STOCK_PLUGINS.map((p) => (
            <div key={p.id} className={'lab-item' + (selected === p.id ? ' on' : '')} onClick={() => setSelected(p.id)}>
              {p.name} <span className="muted small">{p.category}</span>
            </div>
          ))}
          <div className="lab-title">Project plugins</div>
          {project.userPlugins.map((p) => (
            <div key={p.id} className={'lab-item' + (selected === p.id ? ' on' : '')} onClick={() => setSelected(p.id)}>
              {p.name} <span className="muted small">{plugins.some((x) => x.id === p.id) ? p.id : 'not installed'}</span>
            </div>
          ))}
          <div className={'lab-item new' + (selected === 'new' ? ' on' : '')} onClick={() => setSelected('new')}>
            + New from template
          </div>
          <div className="lab-doc">
            <b>How it works</b>
            <p>
              A plugin calls <code>definePlugin</code> with params and a <code>voice()</code> function that builds WebAudio nodes for every note. Under the hood it uses Strudel’s own <code>registerSound</code> and <code>registerControl</code>, so plugins work in patterns, code channels, the WAV export — and on strudel.cc (the exporter embeds them).
            </p>
            <p>
              voice() receives <code>{'{ ac, t, dur, freq, midi, p, a, d, s, r, adsr, noise }'}</code> and returns <code>{'{ node, sources, end }'}</code>. Use single quotes for strings in plugin code.
            </p>
          </div>
        </div>
        <div className="lab-main">
          <div className="cm-host" ref={host} />
          {status && (
            <div className={'lab-status ' + (status.ok ? 'ok' : 'err')}>
              {status.message}
              {status.peaks && (
                <svg viewBox={`0 0 ${status.peaks.length} 40`} preserveAspectRatio="none" className="lab-wave">
                  {status.peaks.map((v, i) => (
                    <rect key={i} x={i} y={20 - v * 20} width={0.8} height={Math.max(0.3, v * 40)} />
                  ))}
                </svg>
              )}
            </div>
          )}
        </div>
      </div>
    </Window>
  );
}
