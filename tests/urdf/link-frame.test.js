import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

import { adjustURDFLinkFrame } from '../../src/utils/URDFLinkFrame.js';

const attr = (tag, name) => tag?.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
const vector = (value, fallback = [0, 0, 0]) => value ? value.split(/\s+/).map(Number) : fallback;
const transform = ({ xyz, rpy }) => new Matrix4().compose(new Vector3(...xyz),
    new Quaternion().setFromEuler(new Euler(...rpy, 'ZYX')), new Vector3(1, 1, 1));
const originMatrix = block => {
    const tag = block.match(/<origin\b[^>]*>/)?.[0];
    return transform({ xyz: vector(attr(tag, 'xyz')), rpy: vector(attr(tag, 'rpy')) });
};
const OFFSET = { xyz: [0.1, -0.2, 0.3], rpy: [0.4, -0.7, 1.2] };
const MODEL = `<robot name="frame-test">
  <link name="base"><visual><geometry><box size="1 1 1"/></geometry></visual></link>
  <link name="arm">
    <!-- <visual><origin xyz="9 9 9"/></visual> -->
    <visual name="mesh"><origin xyz="0.4 0.2 -0.1" rpy="0.1 0.3 -0.4"/><geometry><mesh filename="part.stl" scale="-1 2 3"/></geometry><material name="paint"/></visual>
    <visual><geometry><box size="0.2 0.4 0.6"/></geometry></visual>
    <collision><origin xyz="-0.2 0.1 0.3" rpy="-0.2 0.4 0.1"/><geometry><sphere radius="0.3"/></geometry></collision>
    <collision><geometry><cylinder radius="0.1" length="0.4"/></geometry></collision>
    <inertial><origin xyz="0.1 -0.2 0.3" rpy="0.4 -0.1 0.2"/><mass value="2"/><inertia ixx="2" ixy="0.1" ixz="0.2" iyy="3" iyz="0.3" izz="4"/></inertial>
  </link>
  <link name="wrist"/>
  <link name="tool"><visual><geometry><box size="1 2 3"/></geometry></visual></link>
  <link name="side"><collision><geometry><sphere radius="0.2"/></geometry></collision></link>
  <link name="follower"/>
  <joint name="drive" type="revolute"><origin xyz="1 -2 3" rpy="0.2 -0.4 0.7"/><parent link="base"/><child link="arm"/><axis xyz="0.2672612419124244 -0.5345224838248488 0.8017837257372732"/><limit lower="-2" upper="2" effort="20" velocity="3"/><dynamics damping="0.2"/><calibration rising="0.1"/></joint>
  <joint name="hinge" type="continuous"><origin xyz="0.3 -0.5 0.2" rpy="0.4 0.2 -0.1"/><parent link="arm"/><child link="wrist"/><axis xyz="0 -1 0"/></joint>
  <joint name="slide" type="prismatic"><parent link="wrist"/><child link="tool"/><axis xyz="0 0 1"/><limit lower="0" upper="1" effort="5" velocity="1"/></joint>
  <joint name="branch" type="fixed"><origin xyz="-0.5 0.2 0.4" rpy="0.2 0.1 0.3"/><parent link="arm"/><child link="side"/></joint>
  <joint name="copy" type="revolute"><parent link="base"/><child link="follower"/><axis xyz="1 0 0"/><mimic joint="drive" multiplier="-2" offset="0.1"/></joint>
  <transmission name="motor"><joint name="drive"><hardwareInterface>position</hardwareInterface></joint></transmission>
  <gazebo reference="arm"><sensor name="camera"><origin xyz="8 8 8"/></sensor></gazebo>
</robot>`;

// Independent forward kinematics: compare physical world transforms rather
// than how the implementation chooses to serialize compensation transforms.
function parse(xml) {
    const active = xml.replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(transmission|gazebo)\b[^>]*>[\s\S]*?<\/\1>/g, '');
    const links = new Map([...active.matchAll(/<link\b[^>]*?(?:\/\s*>|>[\s\S]*?<\/link\s*>)/g)]
        .map(([block]) => [attr(block.match(/<link\b[^>]*>/)[0], 'name'), block]));
    const joints = new Map([...active.matchAll(/<joint\b[^>]*>[\s\S]*?<\/joint\s*>/g)].map(([block]) => {
        const tag = block.match(/<joint\b[^>]*>/)[0];
        const name = attr(tag, 'name');
        return [name, {
            block, type: attr(tag, 'type'),
            parent: attr(block.match(/<parent\b[^>]*>/)?.[0], 'link'),
            child: attr(block.match(/<child\b[^>]*>/)?.[0], 'link')
        }];
    }));
    return { links, joints };
}

function world(xml, pose) {
    const { links, joints } = parse(xml);
    const linkWorld = new Map();
    const jointWorld = new Map();
    const jointValue = name => {
        const mimic = joints.get(name).block.match(/<mimic\b[^>]*>/)?.[0];
        return mimic ? jointValue(attr(mimic, 'joint')) * Number(attr(mimic, 'multiplier') ?? 1)
            + Number(attr(mimic, 'offset') ?? 0) : pose[name] ?? 0;
    };
    function linkTransform(name) {
        if (linkWorld.has(name)) return linkWorld.get(name);
        const incoming = [...joints.entries()].find(([, joint]) => joint.child === name);
        let matrix = new Matrix4();
        if (incoming) {
            const [jointName, joint] = incoming;
            matrix = linkTransform(joint.parent).clone().multiply(originMatrix(joint.block));
            const axis = new Vector3(...vector(attr(joint.block.match(/<axis\b[^>]*>/)?.[0], 'xyz'), [1, 0, 0])).normalize();
            const value = jointValue(jointName);
            if (['revolute', 'continuous'].includes(joint.type)) matrix.multiply(new Matrix4().makeRotationAxis(axis, value));
            if (joint.type === 'prismatic') matrix.multiply(new Matrix4().makeTranslation(...axis.multiplyScalar(value).toArray()));
            jointWorld.set(jointName, matrix.clone());
        }
        linkWorld.set(name, matrix);
        return matrix;
    }
    const attachments = new Map();
    for (const [name, block] of links) {
        const matrix = linkTransform(name);
        [...block.matchAll(/<(visual|collision|inertial)\b[^>]*>[\s\S]*?<\/\1\s*>/g)]
            .forEach(([element], index) => attachments.set(`${name}:${index}`, matrix.clone().multiply(originMatrix(element))));
    }
    return { linkWorld, jointWorld, attachments };
}

function nearMatrix(actual, expected, label) {
    assert.ok(actual, `${label} exists`);
    actual.elements.forEach((value, index) => assert.ok(Math.abs(value - expected.elements[index]) < 2e-10,
        `${label}[${index}]: ${value} != ${expected.elements[index]}`));
}

function preserves(xml, updated, selected, delta) {
    for (const pose of [
        { drive: 0, hinge: 0, slide: 0 },
        { drive: 0.8, hinge: -1.1, slide: 0.6 },
        { drive: -1.5, hinge: 2.4, slide: 0.2 }
    ]) {
        const old = world(xml, pose);
        const next = world(updated, pose);
        for (const [key, expected] of old.attachments) nearMatrix(next.attachments.get(key), expected, key);
        for (const [key, expected] of old.jointWorld) {
            const joint = parse(xml).joints.get(key);
            nearMatrix(next.jointWorld.get(key), joint.child === selected ? expected.clone().multiply(delta) : expected, key);
        }
        for (const [key, expected] of old.linkWorld) {
            nearMatrix(next.linkWorld.get(key), key === selected ? expected.clone().multiply(delta) : expected, key);
        }
        const oldJoints = parse(xml).joints;
        const newJoints = parse(updated).joints;
        assert.deepEqual([...parse(updated).links.keys()], [...parse(xml).links.keys()]);
        assert.deepEqual([...newJoints.keys()], [...oldJoints.keys()]);
        for (const [name, joint] of oldJoints) {
            assert.equal(newJoints.get(name).child, joint.child);
            assert.equal(newJoints.get(name).parent, joint.parent);
            if (['revolute', 'continuous'].includes(joint.type)) {
                const oldAxis = new Vector3(...vector(attr(joint.block.match(/<axis\b[^>]*>/)?.[0], 'xyz'), [1, 0, 0]))
                    .transformDirection(old.jointWorld.get(name));
                const newAxis = new Vector3(...vector(attr(newJoints.get(name).block.match(/<axis\b[^>]*>/)?.[0], 'xyz'), [1, 0, 0]))
                    .transformDirection(next.jointWorld.get(name));
                assert.ok(oldAxis.distanceTo(newAxis) < 2e-10, `${name}: physical axis direction`);
                const displacement = new Vector3().setFromMatrixPosition(next.jointWorld.get(name))
                    .sub(new Vector3().setFromMatrixPosition(old.jointWorld.get(name)));
                assert.ok(displacement.cross(oldAxis).length() < 2e-10, `${name}: physical axis line`);
            }
        }
    }
}

test('changes a link frame while preserving geometry, inertia, descendants and physical motion across poses', () => {
    const updated = adjustURDFLinkFrame(MODEL, 'arm', OFFSET);
    preserves(MODEL, updated, 'arm', transform(OFFSET));
    for (const pattern of [/<mesh[^>]*>/, /<mass[^>]*>/, /<inertia\b[^>]*>/, /<limit[^>]*>/,
        /<mimic[^>]*>/, /<dynamics[^>]*>/, /<calibration[^>]*>/,
        /<transmission[\s\S]*?<\/transmission>/, /<gazebo[\s\S]*?<\/gazebo>/, /<!--[\s\S]*?-->/]) {
        assert.equal(updated.match(pattern)[0], MODEL.match(pattern)[0]);
    }
});

test('supports leaf and empty links, arbitrary prismatic/fixed offsets, and rotations about any local axis', () => {
    for (const [selected, xyz] of [
        ['wrist', [0, -0.3, 0]], ['tool', [0.3, -0.2, 0.5]],
        ['side', [0.3, -0.2, 0.5]], ['follower', [0.3, 0, 0]]
    ]) {
        const offset = { xyz, rpy: OFFSET.rpy };
        preserves(MODEL, adjustURDFLinkFrame(MODEL, selected, offset), selected, transform(offset));
    }
});

test('rotation-only and translation-only adjustments preserve motion', () => {
    for (const offset of [
        { xyz: [0, 0, 0], rpy: OFFSET.rpy },
        { xyz: OFFSET.xyz, rpy: [0, 0, 0] }
    ]) preserves(MODEL, adjustURDFLinkFrame(MODEL, 'arm', offset), 'arm', transform(offset));
});

test('repeated adjustments compose in the current frame without changing link or joint counts', () => {
    const once = adjustURDFLinkFrame(MODEL, 'arm', OFFSET);
    const newAxis = vector(attr(parse(once).joints.get('drive').block.match(/<axis\b[^>]*>/)[0], 'xyz'));
    const second = { xyz: newAxis.map(value => value * 0.2), rpy: [-0.2, 0.4, -0.7] };
    const twice = adjustURDFLinkFrame(once, 'arm', second);
    preserves(MODEL, twice, 'arm', transform(OFFSET).multiply(transform(second)));
    assert.equal(parse(once).links.size, parse(twice).links.size);
    assert.equal(parse(once).joints.size, parse(twice).joints.size);
    preserves(once, twice, 'arm', transform(second));
});

test('adjusting adjacent frames preserves the original joint and geometry poses', () => {
    const arm = adjustURDFLinkFrame(MODEL, 'arm', OFFSET);
    const wristOffset = { xyz: [0, 0.3, 0], rpy: OFFSET.rpy };
    const wrist = adjustURDFLinkFrame(arm, 'wrist', wristOffset);
    const side = adjustURDFLinkFrame(wrist, 'side', OFFSET);
    preserves(arm, wrist, 'wrist', transform(wristOffset));
    preserves(wrist, side, 'side', transform(OFFSET));
});

test('handles RPY singularities and near-singular rotations accurately', () => {
    for (const pitch of [Math.PI / 2, -Math.PI / 2, Math.PI / 2 - 1e-8]) {
        const offset = { xyz: OFFSET.xyz, rpy: [0.4, pitch, -0.2] };
        preserves(MODEL, adjustURDFLinkFrame(MODEL, 'arm', offset), 'arm', transform(offset));
    }
});

test('does not add helpers or modify similarly named existing links', () => {
    const xml = MODEL.replace('</robot>', '<link name="arm_frame_base"/><link name="arm_frame_adjustment"/></robot>');
    const updated = adjustURDFLinkFrame(xml, 'arm', OFFSET);
    const parsed = parse(updated);
    assert.equal(parsed.links.get('arm_frame_base'), '<link name="arm_frame_base"/>');
    assert.equal(parsed.links.get('arm_frame_adjustment'), '<link name="arm_frame_adjustment"/>');
    assert.equal(parsed.links.size, parse(xml).links.size);
    assert.equal(parsed.joints.size, parse(xml).joints.size);
    assert.ok(!updated.includes('link-frame-adjustment'));
});

test('ignores commented joints and accepts single quotes, missing origins and default axes', () => {
    const xml = MODEL.replace(/"/g, "'").replace(/<origin[^>]*\/>/g, '').replace(/<axis[^>]*\/>/g, '')
        .replace('</robot>', "<!-- <joint name='fake' type='fixed'><parent link='arm'/><child link='base'/></joint> --></robot>");
    const offset = { ...OFFSET, xyz: [0.3, 0, 0] };
    preserves(xml, adjustURDFLinkFrame(xml, 'arm', offset), 'arm', transform(offset));
    const escaped = MODEL.replace(/"arm"/g, () => '"arm$&amp;part"');
    const updated = adjustURDFLinkFrame(escaped, 'arm$&part', OFFSET);
    assert.ok(updated.includes('<child link="arm$&amp;part"/>'));
    assert.ok(!updated.includes('frame_base'));
});

test('zero adjustment leaves XML unchanged and invalid input is rejected', () => {
    assert.equal(adjustURDFLinkFrame(MODEL, 'arm', { xyz: [0, 0, 0], rpy: [0, 0, 0] }), MODEL);
    assert.throws(() => adjustURDFLinkFrame(MODEL, 'missing', OFFSET), /not found/);
    assert.throws(() => adjustURDFLinkFrame(MODEL, 'arm', { ...OFFSET, xyz: [NaN, 0, 0] }), /finite/);
    assert.throws(() => adjustURDFLinkFrame(MODEL, 'arm', { ...OFFSET, rpy: [0, Infinity, 0] }), /finite/);
    assert.throws(() => adjustURDFLinkFrame(MODEL, 'arm', { ...OFFSET, rpy: [0, 0] }), /finite/);
    assert.throws(() => adjustURDFLinkFrame(MODEL.replace('rpy="0.4 -0.1 0.2"', 'rpy="bad 0 0"'), 'arm', OFFSET), /finite/);
    const twoParents = MODEL.replace('</robot>', '<joint name="other" type="fixed"><parent link="base"/><child link="arm"/></joint></robot>');
    assert.throws(() => adjustURDFLinkFrame(twoParents, 'arm', OFFSET), /at most one/);
    assert.throws(() => adjustURDFLinkFrame(MODEL, 'base', OFFSET), /root link/);
    assert.throws(() => adjustURDFLinkFrame(MODEL, 'arm', { ...OFFSET, xyz: [0.3, -0.2, 0.5] }), /rotation axis/);
    assert.throws(() => adjustURDFLinkFrame(MODEL.replace('type="revolute"', 'type="floating"'), 'arm', OFFSET), /does not support/);
});
