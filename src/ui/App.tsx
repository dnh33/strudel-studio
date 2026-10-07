import { useEffect, useState } from 'react';
import { useStudio } from '../store/store';
import { TopBar } from './TopBar';
import { Browser } from './Browser';
import { Playlist } from './windows/Playlist';
import { ChannelRack } from './windows/ChannelRack';
import { PianoRoll } from './windows/PianoRoll';
import { Mixer } from './windows/Mixer';
import { CodeWindow } from './windows/CodeWindow';
import { ChannelSettings } from './windows/ChannelSettings';
import { AutomationEditor } from './windows/AutomationEditor';
import { PluginLab } from './windows/PluginLab';
import { Help } from './windows/Help';
import { MenuHost, DialogHost } from './components/Menu';
import { engine } from '../engine/engine';

function HintBar() {
  const hint = useStudio((s) => s.hint);
  const status = useStudio((s) => s.engineStatus);
  const msg = useStudio((s) => s.engineMessage);
  const err = useStudio((s) => s.evalError);
  const mode = useStudio((s) => s.mode);
  const recording = useStudio((s) => s.recording);
  return (
    <footer className="hintbar">
      <span className={'status-dot ' + status} title={status} />
      <span className="hint">{hint || 'Hover anything for hints · F1 for help'}</span>
      <span className="spacer" />
      {recording && <span className="rec-badge">● REC {mode !== 'pattern' ? '(pattern mode only)' : ''}</span>}
      {err ? <span className="hint-error" title={err}>⚠ {err.slice(0, 140)}</span> : <span className="muted">{msg}</span>}
    </footer>
  );
}

function AudioGate() {
  const [suspended, setSuspended] = useState(true);
  const status = useStudio((s) => s.engineStatus);
  useEffect(() => {
    const t = setInterval(() => setSuspended(!engine.ctx || engine.ctx.state !== 'running'), 500);
    return () => clearInterval(t);
  }, []);
  if (!suspended && status === 'ready') return null;
  return (
    <div className="audio-gate" onClick={() => engine.resume()}>
      {status === 'failed' ? '⚠ Audio engine failed — see console' : status !== 'ready' ? '⏳ Loading Strudel engine & sample libraries…' : '🔊 Click anywhere to enable audio'}
    </div>
  );
}

export function App() {
  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <TopBar />
      <div className="main">
        <Browser />
        <div className="workspace" id="workspace">
          <Playlist />
          <ChannelRack />
          <CodeWindow />
          <PianoRoll />
          <Mixer />
          <ChannelSettings />
          <AutomationEditor />
          <PluginLab />
          <Help />
        </div>
      </div>
      <HintBar />
      <AudioGate />
      <MenuHost />
      <DialogHost />
    </div>
  );
}
