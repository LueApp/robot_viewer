import { build } from 'vite';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repo);
const { values } = parseArgs({ options: { outDir: { type: 'string', default: 'dist' } } });
const outDir = path.resolve(repo, values.outDir);
await build({ build: { outDir } });
execFileSync(process.execPath, ['scripts/build-offline-html.mjs'], { cwd: repo, stdio: 'inherit' });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const source = path.join(repo, 'build/offline', `robot-viewer-${version}-offline.html`);
const downloads = path.join(outDir, 'downloads');
await mkdir(downloads, { recursive: true });
await cp(source, path.join(downloads, 'robot-viewer-offline.html'));
console.log(`Website includes offline download: ${path.join(downloads, 'robot-viewer-offline.html')}`);
