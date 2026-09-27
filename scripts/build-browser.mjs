import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: project,
  entryPoints: ['src/browser/cashtab.ts'],
  outfile: resolve(project, 'public/cashtab.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'info',
});
