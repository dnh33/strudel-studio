import type { Project } from '../model/types';
import { getState, useStudio } from '../store/store';
import { migrateProject } from '../store/migrate';
import { createEmptyProject } from '../model/factory';
import { confirmDialog, useDialog } from './components/Menu';
import { installPlugin } from '../plugins/registry';
import { putStoredProject } from '../engine/userSamples';
import { uid } from '../model/util';
import { projectToMidi } from '../model/midifile';
import { stop } from '../store/transport';
import { isNative, native, writeBinaryFile } from '../native/bridge';
import { applyProjectStates, projectWithStates, useNative } from '../native/nativeStudio';

export function download(blob: Blob, name: string) {
  if (isNative) {
    saveBlobNative(blob, name);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** native app: "Save as" dialog + chunked write */
async function saveBlobNative(blob: Blob, name: string) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const path = await native.chooseFile({ mode: 'save', title: 'Save ' + name, name, filters: ext ? '*' + ext : '*' });
  if (!path) return;
  const ok = await writeBinaryFile(path, new Uint8Array(await blob.arrayBuffer()));
  if (ok) {
    getState().log(`Saved ${path}`);
    getState().setHint(`Saved ${path.split(/[\\/]/).pop()} ✓`);
  } else getState().log(`Could not write ${path}`, 'error');
}

export function downloadText(text: string, name: string, type = 'text/javascript') {
  download(new Blob([text], { type }), name);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    getState().log('Copied to clipboard');
    getState().setHint('Copied to clipboard ✓');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function toBase64Unicode(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function strudelUrl(code: string) {
  return 'https://strudel.cc/#' + encodeURIComponent(toBase64Unicode(code));
}

export function openInStrudel(code: string) {
  window.open(strudelUrl(code), '_blank', 'noopener');
}

export const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'project';

// ----------------------------------------------------------- projects
export function installProjectPlugins(p: Project) {
  for (const up of p.userPlugins ?? []) {
    try {
      installPlugin(up.source, false);
    } catch (e) {
      getState().log(`Plugin "${up.name}" failed to load: ${(e as Error).message}`, 'error');
    }
  }
}

export function loadProjectGuarded(p: Project | null, fileName: string | null = null, path: string | null = null) {
  const doLoad = () => {
    stop();
    const project = p ? migrateProject(p) : createEmptyProject('Untitled');
    installProjectPlugins(project);
    getState().loadProject(project, fileName);
    getState().log(`Loaded project "${project.name}"`);
    if (isNative) {
      useNative.setState({ savePath: path });
      applyProjectStates(project);
    }
  };
  if (getState().dirty) confirmDialog('Discard changes?', 'The current project has unsaved changes. Load anyway? (It is still in the autosave until you change something.)', doLoad, 'Load');
  else doLoad();
}

export async function saveProjectFile(saveAs = false) {
  const p = getState().project;
  const name = safeName(p.name) + '.strudel-studio.json';
  if (isNative) {
    let path = saveAs ? null : useNative.getState().savePath;
    if (!path) path = await native.chooseFile({ mode: 'save', title: 'Save project', name, filters: '*.json' });
    if (!path) return;
    if (!/\.json$/i.test(path)) path += '.json';
    const withStates = await projectWithStates(p);
    const ok = await native.writeFile(path, JSON.stringify(withStates, null, 1));
    if (!ok) {
      getState().log(`Could not write ${path}`, 'error');
      return;
    }
    native.saveSession();
    useNative.setState({ savePath: path });
    const fileName = path.split(/[\\/]/).pop() ?? name;
    useStudio.setState({ dirty: false, fileName });
    getState().log(`Saved ${path}`);
    getState().setHint(`Saved ${fileName} ✓`);
    return;
  }
  downloadText(JSON.stringify(p, null, 1), name, 'application/json');
  useStudio.setState({ dirty: false, fileName: name });
}

export async function saveToBrowser() {
  const s = getState();
  const p = s.project;
  const id = (p as Project & { storeId?: string }).storeId ?? uid('pj');
  s.update((d) => {
    (d as Project & { storeId?: string }).storeId = id;
  });
  const json = JSON.stringify(getState().project);
  await putStoredProject({ id, name: p.name, updatedAt: Date.now(), json });
  useStudio.setState({ dirty: false });
  s.log(`Saved "${p.name}" to browser storage`);
  s.setHint(`Saved "${p.name}" ✓`);
}

async function openProjectFileNative() {
  const path = await native.chooseFile({ mode: 'open', title: 'Open project', filters: '*.json' });
  if (!path) return;
  const text = await native.readFile(path);
  try {
    if (text == null) throw new Error('Could not read ' + path);
    loadProjectGuarded(JSON.parse(text), path.split(/[\\/]/).pop() ?? path, path);
  } catch (e) {
    getState().log(`Could not open ${path}: ${(e as Error).message}`, 'error');
  }
}

export function openProjectFile() {
  if (isNative) {
    openProjectFileNative();
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      loadProjectGuarded(json, f.name);
    } catch (e) {
      useDialog.getState().show(
        <div className="prompt">
          <h3>Could not open file</h3>
          <p>{String((e as Error).message)}</p>
          <div className="dialog-buttons">
            <button className="primary" onClick={() => useDialog.getState().close()}>
              OK
            </button>
          </div>
        </div>,
      );
    }
  };
  input.click();
}

export function exportMidi() {
  const s = getState();
  const bytes = projectToMidi(s.project, s.mode === 'pattern' ? s.patternId : null);
  download(new Blob([bytes], { type: 'audio/midi' }), safeName(s.project.name) + (s.mode === 'pattern' ? '-pattern' : '') + '.mid');
}
