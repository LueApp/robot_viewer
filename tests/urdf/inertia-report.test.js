import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseInertiaReport, decodeInertiaReport, InertiaReportPreview } from '../../src/utils/InertiaReport.js';
import { InertialVisualization } from '../../src/renderer/InertialVisualization.js';
import { FileHandler } from '../../src/controllers/FileHandler.js';

// Synthetic report with the same Chinese labels and two different COM headings
// used by SolidWorks. The origin tensor deliberately differs from the COM tensor.
const report = `测试装配体.stp 的质量属性
    配置： 默认
    坐标系： base_link
质量（用户覆盖） = 2.50000000 千克
体积 = 1000000 立方毫米
质心（用户覆盖）( 米 )
    X = 0.01000000
    Y = -0.02000000
    Z = 0.03000000
惯性主轴和惯性主力矩: ( 千克 * 平方米 )
由重心决定。
 Ix = (1, 0, 0) Px = 0.01000000
惯性张量: ( 千克 * 平方米 )
由重心决定，并且对齐输出的坐标系。（使用负张量记数法。）
 Lxx = 0.01000000 Lxy = -0.00100000 Lxz = 0.00200000
 Lyx = -0.00100000 Lyy = 0.02000000 Lyz = -0.00300000
 Lzx = 0.00200000 Lzy = -0.00300000 Lzz = 0.02500000
惯性张量: ( 千克 * 平方米 )
由输出坐标系决定。
 Ixx = 9.00000000 Ixy = 8.00000000 Ixz = 7.00000000
 Iyx = 8.00000000 Iyy = 6.00000000 Iyz = 5.00000000
 Izx = 7.00000000 Izy = 5.00000000 Izz = 4.00000000
已在装配体级别覆盖质量属性。因此，
 TEST.stp<默认>@ASSEMBLY.stp<默认>
`;

test('Chinese CAD reports preserve COM tensor values and ignore origin/principal tensors', () => {
    const second = report.replace('base_link', 'wheel_link').replace('质心（用户覆盖）', '重心 :');
    const records = parseInertiaReport('\uFEFF' + (report + '\n\n' + second).replaceAll('\n', '\r\n'));
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(record => record.name), ['base_link', 'wheel_link']);
    assert.deepEqual(records[0].inertial, {
        mass: 2.5, origin: { xyz: [0.01, -0.02, 0.03], rpy: [0, 0, 0] },
        ixx: 0.01, iyy: 0.02, izz: 0.025, ixy: -0.001, ixz: 0.002, iyz: -0.003
    });
    assert.deepEqual(records[1].inertial, records[0].inertial);
});

test('English labels, exponent notation and mass/length/tensor units normalize to SI', () => {
    const english = report
        .replace('坐标系：', 'Coordinate system:')
        .replace('质量（用户覆盖） = 2.50000000 千克', 'Mass (User Override) = 2.5e3 grams')
        .replace('质心（用户覆盖）( 米 )', 'Center of mass: ( millimeters )')
        .replace('X = 0.01000000', 'X = 1e1').replace('Y = -0.02000000', 'Y = -2e1').replace('Z = 0.03000000', 'Z = 3e1')
        .replaceAll('惯性张量: ( 千克 * 平方米 )', 'Moments of inertia: ( kilograms * square millimeters )');
    const { inertial } = parseInertiaReport(english)[0];
    assert.equal(inertial.mass, 2.5);
    assert.deepEqual(inertial.origin.xyz, [0.01, -0.02, 0.03]);
    assert.ok(Math.abs(inertial.ixx - 1e-8) < 1e-20);
    assert.ok(Math.abs(inertial.ixy + 1e-9) < 1e-20);
});

test('empty, duplicate, incomplete, invalid and unsupported reports fail explicitly', () => {
    for (const [input, message] of [
        ['', /No coordinate systems/],
        [report + report, /base_link: Duplicate/],
        [report.replace('Lxx', 'Missing'), /Missing Lxx/],
        [report.replace('Z = 0.03000000', ''), /invalid Z/],
        [report.replace('2.50000000 千克', '-1 千克'), /non-negative/],
        [report.replace('2.50000000 千克', '1e999 千克'), /finite/],
        [report.replace('2.50000000 千克', '2.5 pounds'), /Unsupported mass unit/],
        [report.replace('( 米 )', '( inches )'), /Unsupported length unit/],
        [report.replace('Lyx = -0.00100000', 'Lyx = 0.01000000'), /not symmetric/],
        [report.replace('Lxx = 0.01000000', 'Lxx = -0.01000000'), /Diagonal inertia/],
        [report + report.replace('base_link', 'broken').replace('Lyy', 'Missing'), /broken: Missing or invalid Lyy/]
    ]) assert.throws(() => parseInertiaReport(input), message);
});

test('UTF-8 and UTF-16 exports decode without losing Chinese names', () => {
    assert.equal(parseInertiaReport(decodeInertiaReport(Buffer.from(report)))[0].name, 'base_link');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(report, 'utf16le')]);
    assert.equal(parseInertiaReport(decodeInertiaReport(utf16))[0].inertial.mass, 2.5);
});

test('preview uses exact matches, retains report data, and restores properties across replacement and clearing', () => {
    const records = parseInertiaReport(report);
    const original = { mass: 99, origin: { xyz: [1, 2, 3] } };
    const base = { inertial: original };
    const other = { inertial: null };
    const model = { links: new Map([['base_link', base], ['base', other]]) };
    const preview = new InertiaReportPreview();
    preview.apply(model, records);
    assert.equal(base.inertial.mass, 2.5);
    assert.equal(other.inertial, null);
    base.inertial.origin.xyz[0] = 7;
    assert.equal(records[0].inertial.origin.xyz[0], 0.01);
    preview.apply({ links: new Map([['base_link', other]]) }, records);
    assert.equal(base.inertial, original);
    assert.equal(other.inertial.mass, 2.5);
    preview.restore();
    assert.equal(other.inertial, null);
    preview.restore();
    assert.equal(base.inertial, original);
});

test('report COM markers and per-link inertia boxes survive refresh and follow link transforms', () => {
    const record = parseInertiaReport(report)[0];
    const root = new THREE.Group();
    const frame = new THREE.Group(); frame.name = record.name; root.add(frame);
    const model = { threeObject: root, links: new Map([[record.name, record]]) };
    const visualization = new InertialVisualization({ scene: new THREE.Scene() });
    visualization.perLinkCOM.add(record.name);
    visualization.perLinkInertia.add(record.name);
    visualization.extractInertialProperties(model);
    assert.equal(visualization.comMarkers.size, 1);
    assert.equal(visualization.inertiaEllipsoids.size, 1);
    assert.equal(visualization.isLinkCOMVisible(record.name), true);
    assert.equal(visualization.isLinkInertiaVisible(record.name), true);
    assert.deepEqual(visualization.comMarkers.get(record.name).position.toArray(), record.inertial.origin.xyz);
    const box = visualization.inertiaEllipsoids.get(record.name);
    let geometryDisposed = false;
    let materialDisposed = false;
    box.geometry.addEventListener('dispose', () => { geometryDisposed = true; });
    box.material.addEventListener('dispose', () => { materialDisposed = true; });
    assert.equal(box.parent, frame);
    frame.position.set(1, 2, 3);
    root.updateMatrixWorld(true);
    assert.ok(box.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(1.01, 1.98, 3.03)) < 1e-12);
    visualization.extractInertialProperties(model);
    assert.equal(visualization.inertiaEllipsoids.size, 1);
    assert.equal(box.parent, null);
    assert.equal(geometryDisposed, true);
    assert.equal(materialDisposed, true);
    visualization.clear();
});

test('dropping a report preserves the loaded model files and mesh resolution map', async () => {
    const handler = new FileHandler();
    const mesh = new File(['solid mesh'], 'robot.stl');
    const modelFile = new File(['<robot/>'], 'robot.urdf');
    handler.fileMap.set('meshes/robot.stl', mesh);
    handler.currentModelFile = modelFile;
    handler.availableModels = [{ file: modelFile }];
    let imported = null;
    handler.onInertiaReport = file => { imported = file; };
    const file = new File([report], 'inertia_1014.txt');
    await handler.handleDrop({ dataTransfer: { files: [file], items: [] } });
    assert.equal(imported, file);
    assert.equal(handler.fileMap.get('meshes/robot.stl'), mesh);
    assert.equal(handler.currentModelFile, modelFile);
    assert.equal(handler.availableModels[0].file, modelFile);
});
