import { build } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import config from '../vite.config.js';
import { collectDependencyNotices } from './offline-licenses.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repo);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const result = await build({
    ...config,
    configFile: false,
    publicDir: false,
    define: { ...config.define, __OFFLINE_HTML__: 'true' },
    plugins: [...config.plugins, {
        name: 'exclude-usd-from-offline-html',
        load(id) {
            if (id === path.join(repo, 'src/adapters/USDAdapter.js')) {
                return 'export class USDAdapter { static async parse() { throw new Error("USD is not included in the offline HTML edition."); } }';
            }
        },
    }],
    build: {
        ...config.build,
        write: false,
        cssCodeSplit: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        modulePreload: false,
        rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: 'viewer.js' } },
    },
});
const output = result.output;
let html = String(output.find(file => file.fileName === 'index.html')?.source ?? '');
if (!html) throw new Error('Vite did not produce index.html');
// The downloaded app has no sibling download directory or need to download itself.
html = html.replace(/<!-- OFFLINE_DOWNLOAD_START -->[\s\S]*?<!-- OFFLINE_DOWNLOAD_END -->/, '');
const scriptText = source => String(source).replace(/<\/script/gi, '<\\/script');
const jsonText = data => JSON.stringify(data).replace(/</g, '\\u003c');
for (const file of output) {
    if (file.type === 'chunk') {
        if (file.imports.length || file.dynamicImports.length) throw new Error('Standalone build still has module imports');
        const script = new RegExp(`<script\\b[^>]*src="(?:\\./)?${file.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*><\\/script>`);
        if (!script.test(html)) throw new Error(`Unreferenced script: ${file.fileName}`);
        html = html.replace(script, () => `<script type="module">${scriptText(file.code)}</script>`);
    } else if (file.fileName.endsWith('.css')) {
        const link = new RegExp(`<link\\b[^>]*href="(?:\\./)?${file.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
        if (!link.test(html)) throw new Error(`Unreferenced stylesheet: ${file.fileName}`);
        html = html.replace(link, () => `<style>${String(file.source).replace(/<\/style/gi, '<\\/style')}</style>`);
    } else if (file.fileName !== 'index.html') throw new Error(`Unembedded asset: ${file.fileName}`);
}
const favicon = 'data:image/svg+xml;base64,' + (await readFile('public/favicon.svg')).toString('base64');
html = html.replaceAll('./favicon.svg', favicon);
const policy = [
    "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval'", "style-src 'unsafe-inline'",
    'img-src blob: data:', 'font-src data:', 'media-src blob: data:', 'connect-src blob: data:',
    "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
html = html.replace('<meta charset="UTF-8">', `<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${policy}">`);
const samples = {};
for (const [name, directory] of [['joint-zero-demo.urdf', 'public/examples'], ['offline-demo.xacro', 'tools/offline/examples'], ['offline-demo.xml', 'tools/offline/examples']]) {
    samples[name] = await readFile(`${directory}/${name}`, 'utf8');
}
const licenses = await readFile('LICENSE', 'utf8') + '\n' + await collectDependencyNotices(repo, pkg.dependencies);
const offlineScript = await readFile('tools/offline/offline.js', 'utf8') + '\n' + await readFile('tools/offline/html-help.js', 'utf8');
html = html.replace('</body>', () => `<script type="application/json" id="offline-samples">${jsonText(samples)}</script>
<script type="application/json" id="offline-licenses">${jsonText(licenses)}</script>
<script>${scriptText(offlineScript)}</script></body>`);

// No runtime may depend on a sibling file; all inputs stay inside this HTML.
if (/<script\b[^>]*\bsrc=/i.test(html) || /<link\b[^>]*\brel="(?:stylesheet|modulepreload)"/i.test(html)) {
    throw new Error('Standalone HTML still references a script or stylesheet');
}
const directory = path.join(repo, 'build/offline');
await mkdir(directory, { recursive: true });
const filename = `robot-viewer-${pkg.version}-offline.html`;
const destination = path.join(directory, filename);
await writeFile(destination, html);
const checksum = createHash('sha256').update(html).digest('hex');
await writeFile(destination + '.sha256', `${checksum}  ${filename}\n`);
console.log(`\nStandalone HTML: ${destination}\nSize: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB\nSHA-256: ${checksum}`);
