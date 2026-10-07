import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../engine/engine';
import { buildDrumMachines, buildFlatMap, GM_SOUNDFONTS, SYNTHS, type LibFolder, type LibItem } from '../engine/library';
import { getInstalledPlugins, onPluginsChanged } from '../plugins/registry';
import { useStudio, getState } from '../store/store';
import * as A from '../store/actions';
import { openContextMenu } from './components/Menu';
import { deleteUserSample, sampleUrls, sanitizeSampleName, saveUserSample, listStoredProjects, deleteStoredProject, type StoredProject } from '../engine/userSamples';
import { DEMOS } from '../model/demos';
import { loadProjectGuarded, openProjectFile } from './fileio';
import { isNative, useNative, scanPlugins } from '../native/nativeStudio';
import type { NativePlugin } from '../native/bridge';

function useLibrary() {
  const [, force] = useState(0);
  useEffect(() => {
    const off1 = engine.on((e) => (e.type === 'samples' || e.type === 'userSamples') && force((x) => x + 1));
    const off2 = onPluginsChanged(() => force((x) => x + 1));
    return () => {
      off1();
      off2();
    };
  }, []);
  const maps = engine.sampleMaps;
  const user = engine.userSamples;
  const plugins = getInstalledPlugins();
  return useMemo(() => {
    const folders: LibFolder[] = [];
    if (maps['tidal-drum-machines.json']) folders.push(buildDrumMachines(maps['tidal-drum-machines.json']));
    if (maps['dirt-samples.json']) folders.push(buildFlatMap('dirt', 'Samples (Dirt)', maps['dirt-samples.json']));
    if (maps['vcsl.json']) folders.push(buildFlatMap('vcsl', 'Instruments (VCSL)', maps['vcsl.json']));
    const misc: LibItem[] = [];
    if (maps['piano.json']) misc.push(...buildFlatMap('piano', 'Piano', maps['piano.json']).items);
    if (maps['mridangam.json']) misc.push(...buildFlatMap('mrid', 'Mridangam', maps['mridangam.json']).items);
    if (misc.length) folders.push({ id: 'misc', label: 'Piano & Percussion', items: misc });
    folders.push({ id: 'synths', label: 'Synths', items: SYNTHS });
    folders.push({ id: 'gm', label: 'Soundfonts (GM)', items: GM_SOUNDFONTS });
    folders.push({
      id: 'plugins',
      label: 'Plugins (Strudel JS)',
      items: plugins.map((p) => ({ id: 'pl:' + p.id, label: `${p.name}${p.stock ? '' : ' (user)'}`, kind: 'plugin' as const, sound: p.id })),
    });
    folders.push({
      id: 'user',
      label: 'My Samples',
      items: user.map((u) => ({ id: 'us:' + u.name, label: u.name, kind: 'sample' as const, sound: u.name, count: u.files.length })),
    });
    return folders;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maps, user, plugins.length, plugins.map((p) => p.id).join()]);
}

function previewItem(item: LibItem, n = item.n ?? 0) {
  if (item.kind === 'sample') engine.previewSound({ s: item.sound, bank: item.bank || undefined, n, note: item.rootNote && item.rootNote !== 36 ? 'c4' : undefined }, 1.5);
  else engine.previewSound({ s: item.sound, note: item.rootNote ? item.rootNote : 'c4', n }, 0.6);
}

function itemMenu(item: LibItem) {
  const s = getState();
  const ch = s.project.channels.find((c) => c.id === s.channelId);
  return [
    { label: 'Preview', onClick: () => previewItem(item) },
    { label: 'Add as new channel', onClick: () => A.addChannelFromLibrary(item) },
    { label: ch ? `Replace sound of "${ch.name}"` : 'Replace selected channel sound', disabled: !ch, onClick: () => ch && A.replaceChannelSound(ch.id, item) },
    ...(item.count && item.count > 1
      ? [{ label: `Variations (${item.count})`, submenu: Array.from({ length: Math.min(item.count, 32) }, (_, i) => ({ label: `#${i}`, onClick: () => previewItem(item, i) })) }]
      : []),
    ...(item.id.startsWith('us:')
      ? [
          { separator: true },
          {
            label: 'Delete from my samples',
            danger: true,
            onClick: async () => {
              await deleteUserSample(item.sound);
              engine.setUserSamples(engine.userSamples.filter((u) => u.name !== item.sound));
            },
          },
        ]
      : []),
  ];
}

export function Browser() {
  const folders = useLibrary();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set(['drum-machines', 'dm:RolandTR909', 'vst3', 'vst3-inst', 'vst3-fx']));
  const [tab, setTab] = useState<'sounds' | 'projects'>('sounds');
  const fileInput = useRef<HTMLInputElement>(null);
  const status = useStudio((s) => s.engineStatus);

  const toggle = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const results = useMemo(() => {
    if (!q.trim()) return null;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all: LibItem[] = [];
    const walk = (f: LibFolder, path: string) => {
      f.items.forEach((it) => {
        const hay = `${path} ${it.label} ${it.sound} ${it.bank ?? ''}`.toLowerCase();
        if (terms.every((t) => hay.includes(t))) all.push(it);
      });
      f.folders?.forEach((sf) => walk(sf, path + ' ' + sf.label));
    };
    folders.forEach((f) => walk(f, f.label));
    return all.slice(0, 300);
  }, [q, folders]);

  const importFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => /audio|\.wav$|\.mp3$|\.ogg$|\.flac$|\.m4a$/i.test(f.type + f.name));
    for (const f of list) {
      const name = sanitizeSampleName(f.name);
      const data = await f.arrayBuffer();
      const sample = { name, files: [{ fileName: f.name, type: f.type, data }], addedAt: Date.now() };
      await saveUserSample(sample);
      engine.registerUserSample(name, sampleUrls(sample));
      engine.setUserSamples([...engine.userSamples.filter((u) => u.name !== name), sample].sort((a, b) => a.name.localeCompare(b.name)));
      getState().log(`Imported sample "${name}"`);
    }
    setOpen((o) => new Set([...o, 'user']));
  };

  return (
    <aside
      className="browser"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        importFiles(e.dataTransfer.files);
      }}
    >
      <div className="browser-tabs seg">
        <button className={tab === 'sounds' ? 'on' : ''} onClick={() => setTab('sounds')}>
          Sounds
        </button>
        <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>
          Projects
        </button>
      </div>
      {tab === 'projects' ? (
        <ProjectsTab />
      ) : (
        <>
          <input className="browser-search" placeholder="Search sounds… (e.g. 909 kick)" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="browser-tree">
            {status !== 'ready' && <div className="muted small pad">{status === 'failed' ? 'Audio engine failed to start.' : 'Loading libraries…'}</div>}
            {!results && <VstFolder open={open} toggle={toggle} />}
            {results && <VstResults q={q} />}
            {results
              ? results.map((it) => <Item key={it.id} item={it} showBank />)
              : folders.map((f) => <Folder key={f.id} f={f} open={open} toggle={toggle} depth={0} />)}
            {results && !results.length && <div className="muted small pad">No matches.</div>}
          </div>
          <div className="browser-foot">
            <button className="tb-btn" onClick={() => fileInput.current?.click()} title="Import your own audio files (or drop them here)">
              + Import samples
            </button>
            <input ref={fileInput} type="file" accept="audio/*" multiple hidden onChange={(e) => e.target.files && importFiles(e.target.files)} />
          </div>
        </>
      )}
    </aside>
  );
}

function Folder({ f, open, toggle, depth }: { f: LibFolder; open: Set<string>; toggle: (id: string) => void; depth: number }) {
  const isOpen = open.has(f.id);
  const count = f.items.length + (f.folders?.length ?? 0);
  return (
    <div className="lib-folder">
      <div className="lib-folder-head" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggle(f.id)}>
        <span className="caret">{isOpen ? '▾' : '▸'}</span> {f.label} <span className="muted small">{count}</span>
      </div>
      {isOpen && (
        <div>
          {f.folders?.map((sf) => <Folder key={sf.id} f={sf} open={open} toggle={toggle} depth={depth + 1} />)}
          {f.items.map((it) => (
            <Item key={it.id} item={it} depth={depth + 1} />
          ))}
          {!count && <div className="muted small" style={{ paddingLeft: 18 + depth * 12 }}>{f.id === 'user' ? 'Drop audio files here' : 'Empty'}</div>}
        </div>
      )}
    </div>
  );
}

function Item({ item, depth = 0, showBank }: { item: LibItem; depth?: number; showBank?: boolean }) {
  const setHint = useStudio((s) => s.setHint);
  return (
    <div
      className={'lib-item kind-' + item.kind}
      style={{ paddingLeft: 18 + depth * 12 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-studio-lib', JSON.stringify(item));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => previewItem(item)}
      onDoubleClick={() => A.addChannelFromLibrary(item)}
      onContextMenu={(e) => openContextMenu(e, itemMenu(item))}
      onMouseEnter={() => setHint(`${item.label} — click: preview · double-click / drag to rack: new channel · drop on a channel name: replace · right-click: more`)}
    >
      <span className="lib-icon">{item.kind === 'sample' ? '♪' : item.kind === 'synth' ? '∿' : item.kind === 'plugin' ? '◆' : '♫'}</span>
      {showBank && item.bank ? <span className="muted">{item.bank} · </span> : null}
      {item.label}
      {item.count && item.count > 1 ? <span className="muted small"> ×{item.count}</span> : null}
    </div>
  );
}

function ProjectsTab() {
  const [stored, setStored] = useState<StoredProject[]>([]);
  const refresh = () => listStoredProjects().then(setStored).catch(() => setStored([]));
  useEffect(() => {
    refresh();
  }, []);
  return (
    <div className="browser-tree">
      <div className="lib-folder-head static">Demo projects</div>
      {DEMOS.map((d) => (
        <div key={d.id} className="lib-item" onClick={() => loadProjectGuarded(d.make())} style={{ paddingLeft: 18 }}>
          <span className="lib-icon">★</span>
          {d.name}
        </div>
      ))}
      <div className="lib-item" onClick={() => loadProjectGuarded(null)} style={{ paddingLeft: 18 }}>
        <span className="lib-icon">+</span>New empty project
      </div>
      <div className="lib-item" onClick={() => openProjectFile()} style={{ paddingLeft: 18 }}>
        <span className="lib-icon">📂</span>Open project file…
      </div>
      <div className="lib-folder-head static">
        Saved in this browser <button className="icon-btn" onClick={refresh} title="Refresh">⟳</button>
      </div>
      {!stored.length && <div className="muted small pad">Use File → Save to browser to keep projects here.</div>}
      {stored.map((p) => (
        <div
          key={p.id}
          className="lib-item"
          style={{ paddingLeft: 18 }}
          onClick={() => loadProjectGuarded(JSON.parse(p.json))}
          onContextMenu={(e) =>
            openContextMenu(e, [
              { label: 'Open', onClick: () => loadProjectGuarded(JSON.parse(p.json)) },
              { label: 'Delete', danger: true, onClick: () => deleteStoredProject(p.id).then(refresh) },
            ])
          }
          title={new Date(p.updatedAt).toLocaleString()}
        >
          <span className="lib-icon">♫</span>
          {p.name}
          <span className="muted small"> {new Date(p.updatedAt).toLocaleDateString()}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ VST3 (native app)
function vstMenu(p: NativePlugin) {
  const s = getState();
  const ch = s.project.channels.find((c) => c.id === s.channelId);
  const vstCh = ch?.kind === 'vst' ? ch : undefined;
  if (p.isInstrument) {
    return [
      { label: 'Add as new channel', onClick: () => A.addVstChannel(p) },
      { label: ch ? `Use in "${ch.name}"` : 'Use in the selected channel', disabled: !ch, onClick: () => ch && A.setVstInstrument(ch.id, p) },
    ];
  }
  return [
    {
      label: vstCh ? `Add to effect chain of "${vstCh.name}"` : 'Add to the selected VST3 channel',
      disabled: !vstCh,
      onClick: () => vstCh && A.addVstFx(vstCh.id, p),
    },
  ];
}

function VstItem({ p, depth }: { p: NativePlugin; depth: number }) {
  const setHint = useStudio((s) => s.setHint);
  return (
    <div
      className={'lib-item kind-vst'}
      style={{ paddingLeft: 18 + depth * 12 }}
      onDoubleClick={() => {
        if (p.isInstrument) A.addVstChannel(p);
        else {
          const s = getState();
          const ch = s.project.channels.find((c) => c.id === s.channelId);
          if (ch?.kind === 'vst') A.addVstFx(ch.id, p);
          else s.setHint('Select a VST3 channel first to add an effect to it');
        }
      }}
      onContextMenu={(e) => openContextMenu(e, vstMenu(p))}
      onMouseEnter={() =>
        setHint(`${p.name} · ${p.vendor} · ${p.category} ${p.version} — double-click: ${p.isInstrument ? 'new channel' : 'add to the selected VST3 channel'} · right-click: more`)
      }
      title={p.file}
    >
      <span className="lib-icon">{p.isInstrument ? '◈' : '⧉'}</span>
      {p.name}
      <span className="muted small"> {p.vendor}</span>
    </div>
  );
}

function VstFolder({ open, toggle }: { open: Set<string>; toggle: (id: string) => void }) {
  const plugins = useNative((s) => s.plugins);
  const scanning = useNative((s) => s.scanning);
  const progress = useNative((s) => s.scanProgress);
  const file = useNative((s) => s.scanFile);
  if (!isNative) return null;
  const inst = plugins.filter((p) => p.isInstrument);
  const fx = plugins.filter((p) => !p.isInstrument);
  const isOpen = open.has('vst3');
  return (
    <div className="lib-folder">
      <div className="lib-folder-head" style={{ paddingLeft: 6 }} onClick={() => toggle('vst3')}>
        <span className="caret">{isOpen ? '▾' : '▸'}</span> VST3 plug-ins <span className="muted small">{plugins.length}</span>
      </div>
      {isOpen && (
        <div>
          {scanning ? (
            <div className="vst-scan" style={{ paddingLeft: 18 }}>
              <div className="vst-scan-bar">
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="muted small ellipsis" title={file}>
                Scanning… {file.split(/[\\/]/).pop()}
              </div>
            </div>
          ) : (
            <div className="lib-item" style={{ paddingLeft: 18 }} onClick={() => scanPlugins(false)} title="Looks for new VST3 plug-ins in the standard folders (and the extra folders from Audio → VST3 folders)">
              <span className="lib-icon">⟳</span>
              {plugins.length ? 'Scan for new plug-ins' : 'Scan for VST3 plug-ins'}
            </div>
          )}
          <div className="lib-folder-head" style={{ paddingLeft: 18 }} onClick={() => toggle('vst3-inst')}>
            <span className="caret">{open.has('vst3-inst') ? '▾' : '▸'}</span> Instruments <span className="muted small">{inst.length}</span>
          </div>
          {open.has('vst3-inst') && inst.map((p) => <VstItem key={p.id} p={p} depth={2} />)}
          <div className="lib-folder-head" style={{ paddingLeft: 18 }} onClick={() => toggle('vst3-fx')}>
            <span className="caret">{open.has('vst3-fx') ? '▾' : '▸'}</span> Effects <span className="muted small">{fx.length}</span>
          </div>
          {open.has('vst3-fx') && fx.map((p) => <VstItem key={p.id} p={p} depth={2} />)}
        </div>
      )}
    </div>
  );
}

function VstResults({ q }: { q: string }) {
  const plugins = useNative((s) => s.plugins);
  if (!isNative) return null;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = plugins.filter((p) => terms.every((t) => `vst3 ${p.name} ${p.vendor} ${p.category}`.toLowerCase().includes(t))).slice(0, 50);
  return (
    <>
      {hits.map((p) => (
        <VstItem key={p.id} p={p} depth={0} />
      ))}
    </>
  );
}
