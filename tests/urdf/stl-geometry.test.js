import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSTLGeometry } from '../../src/loaders/STLGeometry.js';

function triangle(padding = 0) {
    const data = new Uint8Array(84 + 50 + padding);
    data.set(new TextEncoder().encode('solid binary mesh'));
    const view = new DataView(data.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(108, 1, true);
    view.setFloat32(124, 1, true);
    return data;
}

test('binary STL face counts are validated before allocating triangle buffers', async () => {
    for (const padding of [0, 8]) {
        const mesh = await loadSTLGeometry(new File([triangle(padding)], 'body.STL'));
        assert.equal(mesh.getAttribute('position').count, 3);
        mesh.dispose();
    }
    await assert.rejects(loadSTLGeometry(new File([triangle().slice(0, 110)], 'partial.STL')), /partial.STL.*incomplete STL/);
});

test('an LFS pointer identifies the mesh and the recovery command', async () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 7038484\n';
    await assert.rejects(loadSTLGeometry(new File([pointer], 'base_link.STL')), /base_link.STL.*Git LFS.*git lfs pull/);
});

test('ASCII STL still loads with whitespace or a short empty solid', async () => {
    const facet = 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet';
    for (const [text, count] of [['solid empty\nendsolid empty', 0], ['     solid part\n' + facet + '\nendsolid part', 3]]) {
        const mesh = await loadSTLGeometry(new File([text], 'ascii.stl'));
        assert.equal(mesh.getAttribute('position').count, count);
        mesh.dispose();
    }
});
