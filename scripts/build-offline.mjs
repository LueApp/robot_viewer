import { build } from 'vite';
import { cp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { collectDependencyNotices } from './offline-licenses.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repo);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const withRuntime = !process.argv.includes('--source-only');
if (withRuntime && (process.platform !== 'linux' || process.arch !== 'x64')) {
    throw new Error('Bundled runtime currently supports Linux x64. Use --source-only for an existing Node.js installation.');
}
const name = `robot-viewer-${pkg.version}-offline-test-${withRuntime ? 'linux-x64' : 'source'}`;
const output = path.join(repo, 'build', 'offline');
const bundle = path.join(output, name);
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await build({ build: { outDir: path.join(bundle, 'web'), emptyOutDir: true } });

// The public USD page is copied by Vite without bundling its import map.
const threeRoot = path.join(bundle, 'web', 'vendor', 'three');
await mkdir(path.join(threeRoot, 'build'), { recursive: true });
await cp('node_modules/three/build/three.module.js', path.join(threeRoot, 'build', 'three.module.js'));
await cp('node_modules/three/examples/jsm', path.join(threeRoot, 'examples', 'jsm'), { recursive: true });
await cp('node_modules/three/LICENSE', path.join(threeRoot, 'LICENSE'));
const usdPage = path.join(bundle, 'web', 'usd-viewer', 'usd.html');
await writeFile(usdPage, (await readFile(usdPage, 'utf8')).replaceAll('/node_modules/three/', '/vendor/three/').replace('/favicon.png', '/favicon.svg'));

const index = path.join(bundle, 'web', 'index.html');
await writeFile(index, (await readFile(index, 'utf8')).replace('</head>', '<script src="./offline.js"></script></head>'));
await cp('tools/offline/offline.js', path.join(bundle, 'web', 'offline.js'));
for (const file of ['server.mjs', 'start.sh', 'start.bat', 'README.txt']) await cp(`tools/offline/${file}`, path.join(bundle, file));
await chmod(path.join(bundle, 'start.sh'), 0o755);
await cp('LICENSE', path.join(bundle, 'LICENSE'));
await cp('public/examples', path.join(bundle, 'samples'), { recursive: true });
await cp('tools/offline/examples', path.join(bundle, 'samples'), { recursive: true });
await cp('tools/offline/examples', path.join(bundle, 'web', 'examples'), { recursive: true });

// Carry the installed production dependencies' available license texts.
await writeFile(path.join(bundle, 'THIRD_PARTY_NOTICES.txt'), await collectDependencyNotices(repo, pkg.dependencies));
if (withRuntime) {
    await mkdir(path.join(bundle, 'runtime'));
    await cp(process.execPath, path.join(bundle, 'runtime', 'node'));
    await chmod(path.join(bundle, 'runtime', 'node'), 0o755);
    const license = process.env.OFFLINE_NODE_LICENSE ?? '/usr/share/doc/nodejs/LICENSE';
    await cp(license, path.join(bundle, 'runtime', 'LICENSE'));
}
await writeFile(path.join(bundle, 'BUILD.json'), JSON.stringify({
    app: pkg.name, version: pkg.version, kind: 'offline-test',
    runtime: withRuntime ? { platform: process.platform, arch: process.arch, version: process.version } : null,
    builtAt: new Date().toISOString(),
}, null, 2) + '\n');
const archive = path.join(output, name + '.zip');
await rm(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, name], { cwd: output });
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`);
console.log(`\nOffline test package: ${archive}\nSHA-256: ${checksum}`);
