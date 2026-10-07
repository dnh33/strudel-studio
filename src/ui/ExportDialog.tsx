import { useState } from 'react';
import { getState } from '../store/store';
import { useDialog } from './components/Menu';
import { engine } from '../engine/engine';
import { compileFor } from '../store/transport';
import { download, downloadText, exportMidi, openInStrudel, safeName } from './fileio';
import { songLengthBars } from '../model/compile';
import type { Project } from '../model/types';

type What = 'song' | 'pattern' | 'loop';

export function showExportDialog() {
  useDialog.getState().show(<ExportDialog />);
}

function ExportDialog() {
  const s = getState();
  const p = s.project;
  const pattern = p.patterns.find((x) => x.id === s.patternId);
  const [what, setWhat] = useState<What>(s.loop ? 'loop' : p.clips.length ? 'song' : 'pattern');
  const [loops, setLoops] = useState(2);
  const [tail, setTail] = useState(2);
  const [rate, setRate] = useState(44100);
  const [bits, setBits] = useState<16 | 24 | 32>(16);
  const [stems, setStems] = useState(false);
  const [progress, setProgress] = useState<{ msg: string; frac: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const song = songLengthBars(p);
  const range = what === 'song' ? { start: 0, bars: song } : what === 'loop' && s.loop ? { start: s.loop.start, bars: s.loop.end - s.loop.start } : { start: 0, bars: (pattern?.bars ?? 1) * loops };
  const seconds = (range.bars * p.beatsPerBar * 60) / p.bpm + tail;

  const render = async () => {
    setError(null);
    setDone(null);
    const mode = what === 'pattern' ? 'pattern' : 'song';
    const base = safeName(p.name) + (what === 'pattern' ? `-${safeName(pattern?.name ?? 'pattern')}` : '');
    const jobs: { name: string; project: Project }[] = [];
    if (stems) {
      const used = [...new Set(p.channels.filter((c) => !c.mute).map((c) => c.insert))].sort((a, b) => a - b);
      for (const i of used) {
        const proj: Project = {
          ...p,
          // solo exactly this insert (insert 0 = channels routed straight to master)
          channels: p.channels.map((c) => ({ ...c, mute: c.mute || c.insert !== i, solo: false })),
        };
        jobs.push({ name: `${base}-stem-${i === 0 ? 'master' : i + '-' + safeName(p.mixer[i].name)}`, project: proj });
      }
    } else jobs.push({ name: base, project: p });

    try {
      for (let j = 0; j < jobs.length; j++) {
        const job = jobs[j];
        const res = compileFor(job.project, mode, s.patternId, s.codeErrors, false);
        const blob = await engine.renderWav({
          code: res.code,
          project: job.project,
          startBar: range.start,
          bars: range.bars,
          tailSeconds: tail,
          sampleRate: rate,
          bitDepth: bits,
          onProgress: (msg, frac) => setProgress({ msg: `${jobs.length > 1 ? `[${j + 1}/${jobs.length}] ` : ''}${msg}`, frac: (j + frac) / jobs.length }),
        });
        download(blob, job.name + '.wav');
      }
      setDone(`Exported ${jobs.length} file${jobs.length > 1 ? 's' : ''} ✓ (check your downloads folder)`);
      getState().log(`Exported ${jobs.length} WAV file(s)`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setProgress(null);
    }
  };

  const exportCode = (forStrudel: boolean) => {
    const res = compileFor(p, what === 'pattern' ? 'pattern' : 'song', s.patternId, s.codeErrors, true);
    if (forStrudel) openInStrudel(res.code);
    else downloadText(res.code, safeName(p.name) + '.strudel.js');
  };

  return (
    <div className="export">
      <h3>Export</h3>
      <div className="export-grid">
        <label>What</label>
        <div className="seg">
          <button className={what === 'song' ? 'on' : ''} onClick={() => setWhat('song')} disabled={!p.clips.length}>
            Song ({song} bars)
          </button>
          <button className={what === 'pattern' ? 'on' : ''} onClick={() => setWhat('pattern')}>
            Pattern “{pattern?.name}”
          </button>
          <button className={what === 'loop' ? 'on' : ''} onClick={() => setWhat('loop')} disabled={!s.loop}>
            Loop region
          </button>
        </div>
        {what === 'pattern' && (
          <>
            <label>Repeats</label>
            <input type="number" min={1} max={64} value={loops} onChange={(e) => setLoops(Math.max(1, +e.target.value || 1))} />
          </>
        )}
        <label>Tail</label>
        <div>
          <input type="number" min={0} max={20} step={0.5} value={tail} onChange={(e) => setTail(Math.max(0, +e.target.value || 0))} /> seconds (reverb/delay ring-out)
        </div>
        <label>Sample rate</label>
        <select value={rate} onChange={(e) => setRate(+e.target.value)}>
          <option value={44100}>44.1 kHz</option>
          <option value={48000}>48 kHz</option>
          <option value={96000}>96 kHz</option>
        </select>
        <label>Format</label>
        <select value={bits} onChange={(e) => setBits(+e.target.value as 16 | 24 | 32)}>
          <option value={16}>WAV 16-bit</option>
          <option value={24}>WAV 24-bit</option>
          <option value={32}>WAV 32-bit float</option>
        </select>
        <label>Stems</label>
        <label className="check">
          <input type="checkbox" checked={stems} onChange={(e) => setStems(e.target.checked)} /> one WAV per mixer insert
        </label>
      </div>
      <div className="muted small">
        Length ≈ {seconds.toFixed(1)} s. Rendering is offline (faster than realtime) and includes mixer effects and the master chain. Samples are fetched from the internet on first use.
      </div>
      {progress && (
        <div className="progress">
          <div className="bar" style={{ width: `${Math.round(progress.frac * 100)}%` }} />
          <span>{progress.msg}</span>
        </div>
      )}
      {error && <div className="eval-error">⚠ {error}</div>}
      {done && <div className="ok-msg">{done}</div>}
      <div className="dialog-buttons">
        <button onClick={() => exportMidi()}>MIDI (.mid)</button>
        <button onClick={() => exportCode(false)}>Strudel code (.js)</button>
        <button onClick={() => exportCode(true)}>Open in strudel.cc ↗</button>
        <span className="spacer" />
        <button onClick={() => useDialog.getState().close()}>Close</button>
        <button className="primary" onClick={render} disabled={!!progress}>
          {progress ? 'Rendering…' : 'Render WAV'}
        </button>
      </div>
    </div>
  );
}
