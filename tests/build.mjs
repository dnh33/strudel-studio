import { build } from 'esbuild';
await build({ entryPoints: ['tests/entry.ts'], bundle: true, format: 'esm', platform: 'node', outfile: 'tests/.build/model.mjs', external: ['@strudel/*', 'superdough'], logLevel: 'error' });
