import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/app.css';
import { engine } from './engine/engine';
import { startSync, compileCurrent, runLiveCode } from './store/transport';
import { installKeyboard } from './ui/keyboard';
import { getState, restoredFromAutosave, useStudio } from './store/store';
import { compileProject } from './model/compile';
import { installProjectPlugins } from './ui/fileio';
import { initNative, isNative } from './native/nativeStudio';
import * as nativeStudio from './native/nativeStudio';
import * as nativeBridge from './native/bridge';
import * as actions from './store/actions';
import * as transport from './store/transport';

installKeyboard();
// debugging / automation hooks (used by the end-to-end tests)
(window as unknown as Record<string, unknown>).__studioDebug = { getState, useStudio, compileCurrent, runLiveCode, compileProject, actions, transport, engine, nativeStudio, nativeBridge };
startSync();

engine
  .init()
  .then(() => {
    installProjectPlugins(getState().project);
    getState().log(restoredFromAutosave ? 'Restored your last session from autosave' : 'Loaded demo project "Sunset House" — press Space to play');
    // the native app allows audio without a click
    if (isNative) engine.resume().catch(() => undefined);
  })
  .catch((e) => getState().log('Engine failed: ' + (e?.message ?? e), 'error'));

// Strudel Studio native app (JUCE): VST3 hosting, native audio & MIDI, file dialogs
if (isNative) {
  document.documentElement.classList.add('native-app');
  initNative().catch((e) => getState().log('Native bridge failed: ' + (e?.message ?? e), 'error'));
}

// audio contexts need a user gesture before they can start
const resume = () => {
  engine.resume().catch(() => undefined);
};
window.addEventListener('pointerdown', resume, { capture: true });
window.addEventListener('keydown', resume, { capture: true });

createRoot(document.getElementById('root')!).render(<App />);
