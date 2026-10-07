import type { ParamDef } from '../model/paramDefs';
import type { PluginInfo } from '../model/compile';
import { PLUGIN_SDK_SOURCE, type PluginDefinition } from './sdk';
import { STOCK_PLUGINS } from './instruments';

export interface PluginApi {
  registerSound: (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  registerControl: (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  getAudioContext: () => BaseAudioContext;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  category: string;
  stock: boolean;
  source: string;
  def: PluginDefinition;
  params: (ParamDef & { control: string; optionLabels?: string[] })[];
}

const installed = new Map<string, InstalledPlugin>();
const listeners = new Set<() => void>();
let api: PluginApi | null = null;

export function onPluginsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const emit = () => listeners.forEach((f) => f());

function toParamDefs(def: PluginDefinition) {
  return Object.entries(def.params ?? {}).map(([key, s]) => ({
    key,
    label: s.label ?? key,
    group: def.name,
    min: s.min,
    max: s.max,
    def: s.def,
    step: s.step,
    unit: s.unit,
    curve: s.curve,
    control: `${def.id}_${key}`,
    automatable: s.automatable ?? !s.options,
    options: s.options?.map((label, i) => ({ label, value: i })),
    optionLabels: s.options,
  }));
}

/** evaluates plugin source (which calls definePlugin) and returns the defined plugins */
export function evaluatePluginSource(source: string): PluginDefinition[] {
  if (!api) throw new Error('plugin system not initialised');
  const defs: PluginDefinition[] = [];
  const g = globalThis as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const prevHook = g.__studioPluginHook;
  g.__studioPluginHook = (d: PluginDefinition) => defs.push(d);
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('registerSound', 'registerControl', 'getAudioContext', `${PLUGIN_SDK_SOURCE}\n${source}`);
    fn(api.registerSound, api.registerControl, api.getAudioContext);
  } finally {
    g.__studioPluginHook = prevHook;
  }
  return defs;
}

export function installPlugin(source: string, stock = false): InstalledPlugin[] {
  const defs = evaluatePluginSource(source);
  if (!defs.length) throw new Error('No plugin defined. Call definePlugin({ id, name, params, voice }) in your source.');
  const out: InstalledPlugin[] = [];
  for (const def of defs) {
    if (!def.id || !/^[a-z][a-z0-9]*$/.test(def.id)) throw new Error(`Invalid plugin id "${def.id}" (use lowercase letters/digits)`);
    if (typeof def.voice !== 'function') throw new Error(`Plugin "${def.id}" needs a voice() function`);
    const p: InstalledPlugin = {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description ?? '',
      category: def.category ?? (stock ? 'Synth' : 'User'),
      stock,
      source,
      def,
      params: toParamDefs(def),
    };
    installed.set(def.id, p);
    out.push(p);
  }
  emit();
  return out;
}

export function initPlugins(pluginApi: PluginApi) {
  api = pluginApi;
  for (const sp of STOCK_PLUGINS) {
    try {
      installPlugin(sp.source, true);
    } catch (e) {
      console.error('failed to install stock plugin', sp.id, e);
    }
  }
}

export function getInstalledPlugins(): InstalledPlugin[] {
  return [...installed.values()];
}

export function getPlugin(id: string): InstalledPlugin | undefined {
  return installed.get(id);
}

export function getPluginInfo(id: string): PluginInfo | undefined {
  const p = installed.get(id);
  if (!p) return undefined;
  return { id: p.id, name: p.name, params: p.params, source: p.source };
}

export function isPluginInstalled(id: string) {
  return installed.has(id);
}
