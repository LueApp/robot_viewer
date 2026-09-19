import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Object3D } from 'three';
import { URDFJoint } from 'urdf-loader/src/URDFClasses.js';
import { rebaseURDFJoint } from '../../src/utils/URDFJointZero.js';
import { XMLUpdater } from '../../src/utils/XMLUpdater.js';

const sample = ({ type = 'revolute', origin = '', axis = '0 0 1', extra = '' } = {}) => `
<robot name="zero_test">
  <link name="base"/>
  <link name="arm"><visual><origin xyz="1 2 3"/><geometry><box size="1 2 3"/></geometry></visual></link>
  <joint name="motor" type="${type}">
    ${origin}
    <parent link="base"/><child link="arm"/>
    <axis xyz="${axis}"/>
    <limit lower="0" upper="${Math.PI / 2}" effort="20" velocity="3"/>
    ${extra}
  </joint>
</robot>`;

const attr = (tag, name) => tag?.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
const tag = (xml, name) => XMLUpdater.maskComments(xml).match(new RegExp(`<${name}\\b[^>]*>`))?.[0];
const vector = (text, fallback) => text ? text.split(/\s+/).map(Number) : fallback;
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

// Evaluate the exported XML through the same joint implementation as the viewer,
// including a translated/rotated descendant to catch wrong composition order.
function descendantMatrix(xml, value) {
    const content = XMLUpdater.findNamedBlock(xml, 'joint', 'motor').content;
    const joint = new URDFJoint();
    joint.jointType = attr(tag(content, 'joint'), 'type');
    joint.ignoreLimits = true;
    const origin = tag(content, 'origin');
    joint.position.fromArray(vector(attr(origin, 'xyz'), [0, 0, 0]));
    joint.rotation.copy(new Euler(...vector(attr(origin, 'rpy'), [0, 0, 0]), 'ZYX'));
    joint.axis.fromArray(vector(attr(tag(content, 'axis'), 'xyz'), [1, 0, 0])).normalize();
    const descendant = new Object3D();
    descendant.position.set(0.23, -0.42, 0.91);
    descendant.rotation.set(0.1, -0.2, 0.3);
    joint.add(descendant);
    joint.setJointValue(value);
    joint.updateMatrixWorld(true);
    return descendant.matrixWorld;
}

function samePhysicalMotion(xml, offset, samples) {
    const updated = rebaseURDFJoint(xml, 'motor', offset);
    for (const q of samples) {
        const old = descendantMatrix(xml, q);
        const current = descendantMatrix(updated, q - offset);
        old.elements.forEach((value, index) => near(current.elements[index], value));
    }
    return updated;
}

test('0–90 degrees becomes -45–45 with the old 45-degree pose at zero', () => {
    const xml = sample();
    const updated = samePhysicalMotion(xml, Math.PI / 4, [0, Math.PI / 4, Math.PI / 2]);
    const limit = tag(updated, 'limit');
    near(Number(attr(limit, 'lower')), -Math.PI / 4);
    near(Number(attr(limit, 'upper')), Math.PI / 4);
    assert.equal(attr(limit, 'effort'), '20');
    assert.equal(attr(limit, 'velocity'), '3');
    assert.equal(XMLUpdater.findNamedBlock(updated, 'link', 'arm').content,
        XMLUpdater.findNamedBlock(xml, 'link', 'arm').content);
});

test('preserves descendant transforms for an oblique axis in a rotated joint frame', () => {
    const xml = sample({ origin: '<origin xyz="1 -2 3" rpy="0.4 -0.7 1.1"/>', axis: '2 -3 4' });
    samePhysicalMotion(xml, 0.63, [-1, 0, 0.2, 0.63, 1.57, 2.1]);
    samePhysicalMotion(xml, -0.82, [-1, 0, 0.2, 1.57]);
});

test('supports reversed axes, default origins/axes, and repeated zero changes', () => {
    const xml = sample({ axis: '0 -1 0' });
    const once = samePhysicalMotion(xml, -0.4, [-0.4, 0, 0.4, 1]);
    const twice = rebaseURDFJoint(once, 'motor', 0.7);
    const expected = rebaseURDFJoint(xml, 'motor', 0.3);
    descendantMatrix(twice, 0).elements.forEach((value, i) => near(value, descendantMatrix(expected, 0).elements[i]));
    samePhysicalMotion(xml.replace('<axis xyz="0 -1 0"/>', ''), 0.7, [0, 0.7, 1]);
});

test('handles Euler singularities without changing physical motion', () => {
    for (const pitch of [Math.PI / 2, -Math.PI / 2, Math.PI / 2 - 1e-8]) {
        samePhysicalMotion(sample({ origin: `<origin rpy="0 ${pitch} 0"/>`, axis: '1 0 0' }), 0.7, [0, 0.7, 1]);
    }
});

test('prismatic zero translates along the rotated axis and shifts limits in meters', () => {
    const xml = sample({ type: 'prismatic', origin: '<origin xyz="1 2 3" rpy="0.2 0.4 0.7"/>', axis: '1 2 -1' });
    const updated = samePhysicalMotion(xml, 0.25, [0, 0.25, 0.6, 1.5]);
    near(Number(attr(tag(updated, 'limit'), 'lower')), -0.25);
});

test('continuous joints stay unbounded and missing positional limits stay absent', () => {
    const xml = sample({ type: 'continuous' }).replace(/<limit[^>]*>/, '<limit effort="20" velocity="3"/>');
    const updated = samePhysicalMotion(xml, 4.2, [-7, 0, 4.2, 9]);
    assert.equal(tag(updated, 'limit'), '<limit effort="20" velocity="3"/>');
    const noLimit = xml.replace(/<limit[^>]*>/, '');
    assert.equal(tag(rebaseURDFJoint(noLimit, 'motor', 0.5), 'limit'), undefined);
});

test('shifts soft limits and calibration while preserving unrelated XML and comments', () => {
    const xml = sample({ extra: `<safety_controller soft_lower_limit='0.1' k_position='20' soft_upper_limit='1.4'/>
    <calibration rising='0.2' falling='0.8'/><dynamics damping='0.5' friction='0.2'/>`
    }).replace('<axis', '<!-- <origin xyz="9 9 9"/><limit lower="9" upper="10"/> -->\n    <axis');
    const updated = rebaseURDFJoint(xml, 'motor', 0.4);
    near(Number(attr(tag(updated, 'safety_controller'), 'soft_lower_limit')), -0.3);
    near(Number(attr(tag(updated, 'safety_controller'), 'soft_upper_limit')), 1);
    near(Number(attr(tag(updated, 'calibration'), 'rising')), -0.2);
    near(Number(attr(tag(updated, 'calibration'), 'falling')), 0.4);
    assert.match(updated, /<!-- <origin xyz="9 9 9"\/><limit lower="9" upper="10"\/> -->/);
    assert.match(updated, /<dynamics damping='0.5' friction='0.2'\/>/);
    assert.equal(attr(tag(updated, 'safety_controller'), 'k_position'), '20');
});

test('updates mimic followers so their positions stay unchanged', () => {
    const xml = sample().replace('</robot>', `
      <joint name='follower' type='revolute'><mimic joint='motor' multiplier='-2' offset='0.1'/></joint>
      <joint name='default_follower' type='revolute'><mimic joint='motor'/></joint>
      <joint name='unrelated' type='revolute'><mimic joint='other' offset='0.9'/></joint>
    </robot>`);
    const updated = rebaseURDFJoint(xml, 'motor', 0.4);
    const follower = name => tag(XMLUpdater.findNamedBlock(updated, 'joint', name).content, 'mimic');
    for (const old of [0, 0.4, 1.2]) {
        near(-2 * (old - 0.4) + Number(attr(follower('follower'), 'offset')), -2 * old + 0.1);
        near(old - 0.4 + Number(attr(follower('default_follower'), 'offset')), old);
    }
    assert.equal(attr(follower('unrelated'), 'offset'), '0.9');
    assert.throws(() => rebaseURDFJoint(xml, 'follower', 0.4), /driving joint/);
});

test('rejects invalid offsets, unsupported joints, and malformed numeric data', () => {
    for (const offset of [NaN, Infinity, -Infinity, '45']) {
        assert.throws(() => rebaseURDFJoint(sample(), 'motor', offset), /finite/);
    }
    assert.throws(() => rebaseURDFJoint(sample(), 'missing', 1), /not found/);
    assert.throws(() => rebaseURDFJoint(sample({ type: 'fixed' }), 'motor', 1), /requires/);
    assert.throws(() => rebaseURDFJoint(sample({ axis: '0 0 0' }), 'motor', 1), /zero vector/);
    assert.throws(() => rebaseURDFJoint(sample({ axis: 'bad 0 1' }), 'motor', 1), /finite/);
    assert.throws(() => rebaseURDFJoint(sample().replace('lower="0"', 'lower="bad"'), 'motor', 1), /finite/);
});
