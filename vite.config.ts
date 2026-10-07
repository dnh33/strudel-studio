import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

/**
 * superdough keeps a global pool of re-usable AudioNodes that is not keyed by AudioContext.
 * When we render offline (WAV export) a pooled node from the realtime context could be handed
 * to the OfflineAudioContext (or vice-versa) which throws "InvalidAccessError".
 * This patch makes the pool ignore nodes that belong to a different context than the active one.
 */
const POOL_RE = /(\w+) = (\w+)\.pop\(\)\?\.deref\(\), \1 != null && (\w+)\(\1\)/;
/**
 * webAudioTimeout(ctx, ...) creates its helper gain node on the *global* context instead of `ctx`.
 * If a sound's cleanup fires after we swapped contexts for an offline render, that throws.
 */
const TIMEOUT_RE = /const (\w+) = new ConstantSourceNode\((\w+)\), (\w+) = (\w+)\(0\);/;
/**
 * Some WebViews (WebKitGTK) report destination.maxChannelCount = 0, which makes superdough's
 * `destination.channelCount = maxChannelCount` throw. Keep the default (stereo) in that case.
 */
const CHANNELS_RE = /this\.audioContext\.destination\.channelCount = (\w+), this\.channelMerger = new ChannelMergerNode\((\w+), \{ numberOfInputs: \2\.destination\.channelCount \}\)/;
function patchSuperdough(code: string, id: string): string {
  if (!POOL_RE.test(code) || !TIMEOUT_RE.test(code)) {
    throw new Error(`[strudel-studio] could not patch superdough in ${id} - did the version change?`);
  }
  return code
    .replace(
      POOL_RE,
      '$1 = $2.pop()?.deref(), $1 != null && (!globalThis.__studioAudioCtx || $1.context === globalThis.__studioAudioCtx) && $3($1)',
    )
    .replace(TIMEOUT_RE, 'const $1 = new ConstantSourceNode($2), $3 = (() => { const g = $2.createGain(); g.gain.value = 0; return g; })();')
    .replace(CHANNELS_RE, '$1 > 0 && (this.audioContext.destination.channelCount = $1), this.channelMerger = new ChannelMergerNode($2, { numberOfInputs: Math.max(1, $2.destination.channelCount) })');
}
const isSuperdoughDist = (id: string) => /superdough[\\/]dist[\\/]index\.mjs/.test(id);
// @strudel/webaudio bundles its own copy of superdough's output class
const isWebaudioDist = (id: string) => /@strudel[\\/]webaudio[\\/]dist[\\/]index\.mjs/.test(id);
const patchChannels = (code: string) =>
  code.replace(CHANNELS_RE, '$1 > 0 && (this.audioContext.destination.channelCount = $1), this.channelMerger = new ChannelMergerNode($2, { numberOfInputs: Math.max(1, $2.destination.channelCount) })');

function superdoughPatchPlugin(): Plugin {
  return {
    name: 'strudel-studio:patch-superdough',
    enforce: 'pre',
    transform(code, id) {
      if (isSuperdoughDist(id)) return { code: patchSuperdough(code, id), map: null };
      if (isWebaudioDist(id)) return { code: patchChannels(code), map: null };
      return null;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), superdoughPatchPlugin()],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: 'strudel-studio:patch-superdough-esbuild',
          setup(build) {
            build.onLoad({ filter: /superdough[\\/]dist[\\/]index\.mjs$/ }, async (args) => {
              const code = await fs.promises.readFile(args.path, 'utf8');
              return { contents: patchSuperdough(code, args.path), loader: 'js' };
            });
            build.onLoad({ filter: /@strudel[\\/]webaudio[\\/]dist[\\/]index\.mjs$/ }, async (args) => {
              const code = await fs.promises.readFile(args.path, 'utf8');
              return { contents: patchChannels(code), loader: 'js' };
            });
          },
        },
      ],
    },
  },
  build: {
    outDir: 'app',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  server: { port: 5173, host: true },
});
