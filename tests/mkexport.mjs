import * as core from '@strudel/core';
const M = await import('/home/claude/studio/tests/.build/model.mjs');
M.initPlugins({ registerSound: () => {}, registerControl: core.registerControl, getAudioContext: () => ({}) });
const p = M.createHouseDemo();
const r = M.compileProject(p, { mode: 'song', forExport: true, getPlugin: M.getPluginInfo, reservedNames: new Set(['beat']), allPluginIds: M.getInstalledPlugins().map((p) => p.id) });
(await import('node:fs')).writeFileSync('/home/claude/studio/tests/.shots/song-export.js', r.code);
console.log(r.code.length, 'chars');
