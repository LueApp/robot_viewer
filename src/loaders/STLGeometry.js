import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export async function loadSTLGeometry(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const header = new TextDecoder().decode(bytes.subarray(0, 256));
    const path = file.webkitRelativePath || file.name;
    const t = key => globalThis.window?.i18n?.t(key);

    if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
        const message = t('stlLfsPointer') || 'Git LFS pointer. Run git lfs pull in the model repository, then select the folder again.';
        throw new Error(`${path} · ${message}`);
    }

    // The binary header declares the triangle count. STLLoader allocates from that
    // count before reading the records, so validate it against the actual bytes.
    const headerSize = 84;
    const recordBytes = 50;
    const expectedSize = buffer.byteLength >= headerSize
        ? headerSize + recordBytes * new DataView(buffer).getUint32(80, true)
        : Infinity;
    const loader = new STLLoader();
    if (expectedSize === buffer.byteLength) return loader.parse(buffer);

    if (/^\s*solid/.test(header) && !/[\x00-\x08\x0e-\x1f]/.test(header)) {
        // STLLoader probes byte 80 even for ASCII and looks for "solid" at offset 0–4.
        const start = bytes.indexOf(0x73);
        if (bytes.length >= headerSize && start <= 4) return loader.parse(buffer);
        const ascii = bytes.subarray(start);
        const normalized = new Uint8Array(Math.max(headerSize, ascii.length));
        normalized.set(ascii);
        normalized.fill(32, ascii.length);
        return loader.parse(normalized.buffer);
    }

    // Some exporters append padding after the final triangle.
    if (expectedSize < buffer.byteLength) return loader.parse(buffer.slice(0, expectedSize));
    const message = t('stlInvalidData') || 'Invalid or incomplete STL. Re-export the mesh or download the complete file.';
    throw new Error(`${path} · ${message}`);
}
