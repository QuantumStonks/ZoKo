import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { build } from 'esbuild';
import { openApiDocument } from '../dist/src/openapi.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'dist/http-clients');
await mkdir(output,{recursive:true});
await build({entryPoints:[join(root,'clients/typescript/zoko.ts')],outfile:join(output,'zoko.mjs'),platform:'node',target:'node24',format:'esm',bundle:false});
await copyFile(join(root,'clients/python/zoko.py'),join(output,'zoko.py'));
await copyFile(join(root,'docs/independent-marketplace.md'),join(output,'README.md'));
await writeFile(join(output,'openapi.json'),JSON.stringify(openApiDocument,null,2)+'\n');
await copyFile(join(root,'LICENSE'),join(output,'LICENSE'));
console.log('Independent HTTP clients and versioned OpenAPI emitted to dist/http-clients (no host/plugin prerequisite).');
