import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export async function startServer({ root, port = 43821 } = {}) {
    const webRoot = await realpath(root ?? fileURLToPath(new URL('./web/', import.meta.url)));
    let origin;
    const server = http.createServer(async (req, res) => {
        // An exact HTTP origin deliberately excludes WebSocket connections.
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:",
            "media-src 'self' blob: data:", `connect-src ${origin} blob: data:`,
            "worker-src 'self' blob:", "frame-src 'self'", "object-src 'none'",
            "base-uri 'self'", "form-action 'none'", "frame-ancestors 'self'",
        ].join('; '));
        // USD's threaded WebAssembly requires isolation on the parent and iframes.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        const reject = (status, message) => { res.writeHead(status); res.end(message); };
        if (req.headers.host !== new URL(origin).host) return reject(403, 'Local access only');
        if (req.headers.origin && req.headers.origin !== origin) return reject(403, 'Local access only');
        if (!['GET', 'HEAD'].includes(req.method)) return reject(405, 'Read-only server');
        try {
            const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
            if (pathname.includes('\0') || pathname.includes('\\')) return reject(400, 'Invalid path');
            const candidate = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
            const file = await realpath(candidate);
            if (!file.startsWith(webRoot + path.sep)) return reject(403, 'Invalid path');
            const info = await stat(file);
            if (!info.isFile()) return reject(404, 'Not found');
            res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size });
            if (req.method === 'HEAD') return res.end();
            const stream = createReadStream(file);
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            stream.pipe(res);
        } catch (error) {
            reject(error instanceof URIError ? 400 : 404, 'Not found');
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { server, origin };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const portArg = process.argv.find(arg => arg.startsWith('--port='));
    const port = portArg ? Number(portArg.slice(7)) : 43821;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port value');
    try {
        const { server, origin } = await startServer({ port });
        console.log(`Robot Viewer — offline test\nOpen: ${origin}/\nKeep this window open. Press Ctrl+C to stop.\nExternal assets and live connections are disabled.`);
        if (!process.argv.includes('--no-open')) {
            const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
            const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', origin + '/'] : [origin + '/'];
            const child = spawn(command, args, { detached: true, stdio: 'ignore' });
            child.on('error', () => console.log('Open the address above in your browser.'));
            child.unref();
        }
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
            server.close(); server.closeAllConnections();
        });
    } catch (error) {
        console.error(error.code === 'EADDRINUSE'
            ? 'Port 43821 is in use. Close the other viewer, or run with --port=43822.'
            : `Could not start: ${error.message}`);
        process.exitCode = 1;
    }
}
