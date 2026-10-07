import { useEffect, useRef, useState } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { initEditor, updateMiniLocations, highlightMiniLocations, flash } from '@strudel/codemirror';
import { useStudio, getState } from '../../store/store';
import { Window } from '../components/Window';
import { compileCurrent, runLiveCode, stop } from '../../store/transport';
import { engine } from '../../engine/engine';
import { useTick } from '../ticker';
import { copyText, downloadText, openInStrudel } from '../fileio';
import * as A from '../../store/actions';

type Tab = 'generated' | 'live' | 'console';

function LiveHint() {
  const project = useStudio((s) => s.project);
  const codeErrors = useStudio((s) => s.codeErrors);
  const r = compileCurrent({ project, mode: 'live', patternId: '', codeErrors, liveRun: null });
  const chans = Object.values(r.channelIdents);
  // find a pattern that contains the first channel for a working example
  let example = '';
  for (const p of project.patterns) {
    const pid = r.patternIdents[p.id];
    const ch = project.channels.find((c) => (p.notes[c.id]?.length ?? 0) > 0 || (p.steps[c.id] ?? []).some((v) => v > 0));
    if (pid && ch) {
      const cid = r.channelIdents[ch.id];
      example = `$: ${cid}(${pid}.${cid}).fast(2)`;
      break;
    }
  }
  return (
    <div className="live-hint">
      Ctrl+Enter runs, Ctrl+. stops. Your project is in scope — instruments: <code>{chans.slice(0, 8).join(', ')}</code>
      {chans.length > 8 ? '…' : ''} · patterns: <code>{Object.values(r.patternIdents).slice(0, 6).join(', ')}</code>
      {example && (
        <>
          {' '}· e.g. <code>{example}</code>
        </>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function useEditor(host: React.RefObject<HTMLDivElement>, opts: { readOnly: boolean; initial: string; onChange?: (code: string) => void; onEvaluate?: () => void; onStop?: () => void }) {
  const view = useRef<EditorView | null>(null);
  const cbs = useRef(opts);
  cbs.current = opts;
  useEffect(() => {
    if (!host.current) return;
    const v = initEditor({
      root: host.current,
      initialCode: opts.initial,
      onChange: (u: Any) => {
        if (u.docChanged) cbs.current.onChange?.(u.state.doc.toString());
      },
      onEvaluate: () => cbs.current.onEvaluate?.(),
      onStop: () => cbs.current.onStop?.(),
    }) as EditorView;
    if (opts.readOnly) v.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return view;
}

export function CodeWindow() {
  const [tab, setTab] = useState<Tab>('generated');
  const project = useStudio((s) => s.project);
  const mode = useStudio((s) => s.mode);
  const patternId = useStudio((s) => s.patternId);
  const codeErrors = useStudio((s) => s.codeErrors);
  const evalError = useStudio((s) => s.evalError);
  const logs = useStudio((s) => s.logs);
  const playing = useStudio((s) => s.playing);
  const genHost = useRef<HTMLDivElement>(null);
  const liveHost = useRef<HTMLDivElement>(null);

  const liveRun = useStudio((s) => s.liveRun);
  const res = compileCurrent({ project, mode, patternId, codeErrors, liveRun });

  const gen = useEditor(genHost, { readOnly: true, initial: res.code });
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runLive = async () => {
    const v = live.current;
    if (!v) return;
    const code = v.state.doc.toString();
    A.setProjectField('liveCode', code, 'liveCode');
    flash(v);
    await runLiveCode(code);
  };
  const live = useEditor(liveHost, {
    readOnly: false,
    initial: project.liveCode,
    onChange: (code) => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
      liveTimer.current = setTimeout(() => A.setProjectField('liveCode', code, 'liveCode'), 500);
    },
    onEvaluate: runLive,
    onStop: () => stop(),
  });

  // keep the generated view in sync (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      const v = gen.current;
      if (!v) return;
      const cur = v.state.doc.toString();
      if (cur === res.code) return;
      const scroll = v.scrollDOM.scrollTop;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: res.code } });
      v.scrollDOM.scrollTop = scroll;
      if (engine.lastEvaluated.code === res.code) updateMiniLocations(v, engine.lastEvaluated.miniLocations);
    }, 120);
    return () => clearTimeout(t);
  }, [res.code, gen]);

  // live code changed externally (undo / project load)
  useEffect(() => {
    const v = live.current;
    if (!v) return;
    if (v.state.doc.toString() !== project.liveCode && !liveTimer.current) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: project.liveCode } });
    }
    liveTimer.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.liveCode]);

  // mini-notation locations after each evaluation
  useEffect(
    () =>
      engine.on((e) => {
        if (e.type !== 'evaluated') return;
        const g = gen.current;
        if (g && g.state.doc.toString() === e.code) updateMiniLocations(g, e.miniLocations);
        const l = live.current;
        if (l) {
          const lc = l.state.doc.toString();
          const off = e.code.lastIndexOf(lc);
          if (lc && off >= 0 && getState().mode === 'live') {
            updateMiniLocations(
              l,
              e.miniLocations.filter(([a]) => a >= off).map(([a, b]) => [a - off, b - off]),
            );
          }
        }
      }),
    [gen, live],
  );

  // highlight active events
  useTick(() => {
    const haps = engine.activeHaps();
    const g = gen.current;
    const t = engine.repl?.scheduler?.now?.() ?? 0;
    if (tab === 'generated' && g) highlightMiniLocations(g, t, haps);
    const l = live.current;
    if (tab === 'live' && l) {
      const lc = l.state.doc.toString();
      const off = engine.lastEvaluated.code.lastIndexOf(lc);
      if (off >= 0 && getState().mode === 'live') {
        const shifted = haps.map((h: Any) => ({
          whole: h.whole,
          value: h.value,
          context: { locations: (h.context?.locations ?? []).map((x: Any) => ({ start: x.start - off, end: x.end - off })) },
        }));
        highlightMiniLocations(l, t, shifted);
      }
    }
  }, playing);

  const exportCode = () => compileCurrent(getState(), true).code;

  const toolbar = (
    <>
      <div className="seg tabs">
        <button className={tab === 'generated' ? 'on' : ''} onClick={() => setTab('generated')} title="Code generated from your project">
          Generated
        </button>
        <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')} title="Free live-coding editor (Ctrl+Enter)">
          Live code
        </button>
        <button className={tab === 'console' ? 'on' : ''} onClick={() => setTab('console')}>
          Console{logs.some((l) => l.level === 'error') ? ' •' : ''}
        </button>
      </div>
      {tab === 'generated' && (
        <>
          <button className="tb-btn" onClick={() => copyText(exportCode())} title="Copy standalone code (includes plugin sources)">
            Copy
          </button>
          <button className="tb-btn" onClick={() => openInStrudel(exportCode())} title="Open this code on strudel.cc">
            Open in strudel.cc ↗
          </button>
          <button className="tb-btn" onClick={() => downloadText(exportCode(), `${project.name.replace(/[^\w-]+/g, '_')}.strudel.js`)}>
            Download .js
          </button>
          <button
            className="tb-btn"
            title="Copy the song lines into the live code editor to keep jamming on them"
            onClick={() => {
              const s = getState();
              const song = compileCurrent({ ...s, mode: s.mode === 'live' ? 'song' : s.mode, liveRun: null });
              const body = song.code.slice(song.preamble.length).trim();
              A.setProjectField('liveCode', `// ejected from ${s.mode === 'pattern' ? 'pattern' : 'song'} mode — edit and press Ctrl+Enter\n${body}\n`);
              setTab('live');
            }}
          >
            → Live
          </button>
        </>
      )}
      {tab === 'live' && (
        <>
          <button className="tb-btn primary" onClick={runLive} title="Ctrl+Enter">
            ▶ Run
          </button>
          <button className="tb-btn" onClick={() => stop()} title="Ctrl+.">
            ■ Stop
          </button>
        </>
      )}
    </>
  );

  return (
    <Window id="code" title={`Strudel code — ${mode} mode`} toolbar={toolbar} minW={360} minH={200}>
      <div className="code-win">
        <div className="cm-host" ref={genHost} style={{ display: tab === 'generated' ? 'block' : 'none' }} />
        <div className="cm-host" ref={liveHost} style={{ display: tab === 'live' ? 'block' : 'none' }} />
        {tab === 'console' && (
          <div className="console">
            {logs.length === 0 && <div className="muted">No messages.</div>}
            {[...logs].reverse().map((l, i) => (
              <div key={i} className={'log ' + l.level}>
                <span className="log-time">{new Date(l.time).toLocaleTimeString()}</span> {l.message}
              </div>
            ))}
          </div>
        )}
        {tab === 'live' && <LiveHint />}
        {evalError && <div className="eval-error">⚠ {evalError}</div>}
        {Object.keys(codeErrors).length > 0 && (
          <div className="eval-error">
            ⚠ Code channel error{Object.keys(codeErrors).length > 1 ? 's' : ''} (channel muted until fixed):{' '}
            {Object.entries(codeErrors)
              .map(([id, msg]) => `${project.channels.find((c) => c.id === id)?.name ?? id}: ${msg}`)
              .join(' · ')}
          </div>
        )}
        {res.warnings.length > 0 && <div className="eval-warn">{res.warnings.join(' · ')}</div>}
      </div>
    </Window>
  );
}
