// SolidWorks mass-property reports use L for the tensor at the COM, expressed
// in the output frame. I is about the output origin and must not replace L.
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const FRAME = /^\s*(?:坐标系|座标系|Coordinate\s+system)\s*:\s*(\S[^\n]*)$/gim;

function assigned(text, label) {
    const match = text.match(new RegExp(`(?:^|\\s)${label}\\s*=\\s*(${NUMBER})(?=\\s|$)`, 'im'));
    if (!match || !Number.isFinite(Number(match[1]))) throw new Error(`Missing or invalid ${label}.`);
    return Number(match[1]);
}

function massScale(unit) {
    const value = unit.trim().toLowerCase();
    if (/^(?:千克|公斤|kg|kilograms?)$/.test(value)) return 1;
    if (/^(?:克|g|grams?)$/.test(value)) return 0.001;
    throw new Error(`Unsupported mass unit: ${unit || '(missing)'}. Use kg or g.`);
}

function lengthScale(unit) {
    const value = unit.trim().toLowerCase();
    if (/^(?:米|m|meters?|metres?)$/.test(value)) return 1;
    if (/^(?:毫米|mm|millimeters?|millimetres?)$/.test(value)) return 0.001;
    if (/^(?:厘米|cm|centimeters?|centimetres?)$/.test(value)) return 0.01;
    throw new Error(`Unsupported length unit: ${unit || '(missing)'}. Use m, cm or mm.`);
}

function inertiaScale(header) {
    const match = header.match(/\(\s*([^()*·]+?)\s*[*·]\s*(?:平方\s*(毫米|厘米|米)|(mm|cm|m)\s*(?:\^?2|²)|(square\s+(?:millimeters?|millimetres?|centimeters?|centimetres?|meters?|metres?)))\s*\)/i);
    if (!match) throw new Error('Missing or unsupported inertia units. Use kg * m^2 or kg * mm^2.');
    const length = (match[2] || match[3] || match[4].replace(/^square\s+/i, ''));
    return massScale(match[1]) * lengthScale(length) ** 2;
}

export function parseInertiaReport(content) {
    const text = content.replace(/^\uFEFF/, '').normalize('NFKC').replace(/\r\n?/g, '\n');
    const headers = [...text.matchAll(FRAME)];
    if (!headers.length) throw new Error('No coordinate systems found. Upload a SolidWorks mass-properties report with named coordinate systems.');
    const names = new Set();
    return headers.map((header, index) => {
        const name = header[1].trim();
        try {
            if (names.has(name)) throw new Error('Duplicate coordinate system. Each link must appear once.');
            names.add(name);
            const block = text.slice(header.index + header[0].length, headers[index + 1]?.index ?? text.length);
            const massLine = block.match(/^\s*(?:质量|Mass)(?:\s*\([^\n)]*\))?\s*=\s*([^\n]+)$/im)?.[1];
            const massMatch = massLine?.match(new RegExp(`^(${NUMBER})\\s+(.+?)\\s*$`));
            if (!massMatch) throw new Error('Missing or invalid mass.');
            const mass = Number(massMatch[1]) * massScale(massMatch[2]);
            if (!Number.isFinite(mass) || mass < 0) throw new Error('Mass must be finite and non-negative.');
            const comHeader = /^\s*(?:质心|重心|Center\s+of\s+mass)(?:\s*\([^\n)]*\))?\s*:?\s*\(\s*([^\n)]+)\s*\)/im.exec(block);
            if (!comHeader) throw new Error('Missing center of mass or its units.');
            const scale = lengthScale(comHeader[1]);
            const comBlock = block.slice(comHeader.index + comHeader[0].length);
            const xyz = ['X', 'Y', 'Z'].map(axis => assigned(comBlock, axis) * scale);
            const tensorHeader = [...block.matchAll(/^\s*(?:惯性张量|Moments\s+of\s+inertia)\s*:[^\n]+/gim)]
                .find(match => /^\s*Lxx\s*=/im.test(block.slice(match.index + match[0].length).split(/\n\s*(?:惯性张量|Moments\s+of\s+inertia)\s*:/i)[0]));
            if (!tensorHeader) throw new Error('Missing Lxx…Lzz tensor at the center of mass.');
            const tensorBlock = block.slice(tensorHeader.index + tensorHeader[0].length).split(/\n\s*(?:惯性张量|Moments\s+of\s+inertia)\s*:/i)[0];
            const tensorScale = inertiaScale(tensorHeader[0]);
            const inertial = { mass, origin: { xyz, rpy: [0, 0, 0] } };
            for (const component of ['xx', 'yy', 'zz', 'xy', 'xz', 'yz']) {
                inertial[`i${component}`] = assigned(tensorBlock, `L${component}`) * tensorScale;
            }
            if (['ixx', 'iyy', 'izz'].some(key => inertial[key] < 0)) throw new Error('Diagonal inertia must be non-negative.');
            for (const [upper, lower] of [['xy', 'yx'], ['xz', 'zx'], ['yz', 'zy']]) {
                if (new RegExp(`\\bL${lower}\\s*=`, 'i').test(tensorBlock)) {
                    const reverse = assigned(tensorBlock, `L${lower}`) * tensorScale;
                    const forward = inertial[`i${upper}`];
                    if (Math.abs(reverse - forward) > 1e-8 + Math.max(Math.abs(reverse), Math.abs(forward)) * 1e-6) {
                        throw new Error(`Tensor is not symmetric (L${upper}/L${lower}).`);
                    }
                }
            }
            return { name, inertial };
        } catch (error) {
            throw new Error(`${name}: ${error.message}`);
        }
    });
}

export function decodeInertiaReport(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}

// Keep the source file untouched and restore exact original objects on clear,
// replacement, model changes, or when the report preview is switched off.
export class InertiaReportPreview {
    constructor() { this.originals = new Map(); }

    apply(model, records) {
        this.restore();
        for (const record of records) {
            const link = model?.links.get(record.name);
            if (!link) continue;
            const inertial = structuredClone(record.inertial);
            this.originals.set(link, { original: link.inertial, preview: inertial });
            link.inertial = inertial;
        }
    }

    restore() {
        for (const [link, { original, preview }] of this.originals) {
            if (link.inertial === preview) link.inertial = original;
        }
        this.originals.clear();
    }
}
