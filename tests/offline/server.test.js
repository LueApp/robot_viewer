import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../../tools/offline/server.mjs';

test('offline server confines files and requests to its loopback origin', async t => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'robot-offline-server-'));
    const root = path.join(temporary, 'web');
    await mkdir(root);
    await writeFile(path.join(root, 'index.html'), '<h1>Local viewer</h1>');
    await writeFile(path.join(temporary, 'private.txt'), 'Not part of the viewer');
    await symlink(path.join(temporary, 'private.txt'), path.join(root, 'escape.txt'));
    const { server, origin } = await startServer({ root, port: 0 });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(temporary, { recursive: true, force: true });
    });
    const request = (url = '/', options = {}) => new Promise((resolve, reject) => {
        const req = http.request(origin + url, options, response => {
            let body = '';
            response.on('data', data => { body += data; });
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        });
        req.on('error', reject); req.end();
    });
    assert.equal(server.address().address, '127.0.0.1');
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.body, '<h1>Local viewer</h1>');
    assert.match(response.headers['content-type'], /text\/html/);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp');
    const connect = response.headers['content-security-policy'].split('; ').find(value => value.startsWith('connect-src'));
    assert.equal(connect, `connect-src ${origin} blob: data:`);
    assert.equal((await request('/', { method: 'HEAD' })).body, '');
    assert.equal((await request('/', { method: 'POST' })).status, 405);
    assert.equal((await request('/', { headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await request('/', { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request('/escape.txt')).status, 403);
    assert.equal((await request('/..%2fprivate.txt')).status, 403);
    assert.equal((await request('/missing.js')).status, 404);
    assert.equal((await request('/%ZZ')).status, 400);
});
