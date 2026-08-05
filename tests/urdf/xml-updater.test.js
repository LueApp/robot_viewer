import assert from 'node:assert/strict';
import test from 'node:test';

import { XMLUpdater } from '../../src/utils/XMLUpdater.js';

const URDF = `<?xml version="1.0"?>
<robot name="sample">
  <link name="base">
    <visual name="first">
      <origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry><box size="1 1 1"/></geometry>
    </visual>
    <visual name="mesh">
      <geometry><mesh filename="part.stl"/></geometry>
    </visual>
    <collision>
      <geometry><mesh filename="part.stl"/></geometry>
    </collision>
  </link>
  <link name="arm"/>
  <joint name="arm_joint" type="revolute">
    <parent link="base"/>
    <child link="arm"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
</robot>`;

test('updates one selected geometry origin and adds a missing origin tag', () => {
    const updated = XMLUpdater.updateURDFGeometryOrigin(
        URDF,
        'base',
        'visual',
        1,
        { xyz: [0.1, -0.2, 0.3], rpy: [0, 1.57079632679, 0] }
    );

    assert.match(updated, /<visual name="mesh">\s*<origin xyz="0\.1 -0\.2 0\.3" rpy="0 1\.57079632679 0"\/>/);
    assert.match(updated, /<visual name="first">\s*<origin xyz="0 0 0" rpy="0 0 0"\/>/);
    assert.doesNotMatch(updated, /<collision>\s*<origin/);
});

test('updates an existing collision origin without changing its other content', () => {
    const withOrigin = XMLUpdater.updateURDFGeometryOrigin(
        URDF,
        'base',
        'collision',
        0,
        { xyz: [1, 2, 3], rpy: [-1, -2, -3] }
    );
    const updated = XMLUpdater.updateURDFGeometryOrigin(
        withOrigin,
        'base',
        'collision',
        0,
        { xyz: [4, 5, 6], rpy: [0.1, 0.2, 0.3] }
    );

    assert.match(updated, /<collision>\s*<origin xyz="4 5 6" rpy="0\.1 0\.2 0\.3"\/>/);
    assert.match(updated, /<mesh filename="part\.stl"\/>/);
});

test('adds mesh scale so negative components mirror selected axes', () => {
    const updated = XMLUpdater.updateURDFMeshScale(
        URDF,
        'base',
        'visual',
        1,
        [-1, 1, -1]
    );

    const link = XMLUpdater.findNamedBlock(updated, 'link', 'base').content;
    assert.match(link, /<visual name="mesh">[\s\S]*?<mesh filename="part\.stl" scale="-1 1 -1"\/>/);
    assert.doesNotMatch(link, /<collision>[\s\S]*?<mesh filename="part\.stl" scale=/);
});

test('updates an existing mesh scale and preserves its filename', () => {
    const xml = URDF.replace(
        '<mesh filename="part.stl"/>',
        '<mesh scale="0.001 0.001 0.001" filename="part.stl"/>'
    );
    const updated = XMLUpdater.updateURDFMeshScale(xml, 'base', 'visual', 1, [0.001, -0.001, 0.001]);

    assert.match(updated, /<mesh scale="0\.001 -0\.001 0\.001" filename="part\.stl"\/>/);
});

test('adds joint origin and axis in URDF child order', () => {
    let updated = XMLUpdater.updateURDFJointOrigin(
        URDF,
        'arm_joint',
        { xyz: [0, 0, 0.5], rpy: [0, 0, 1.2] }
    );
    updated = XMLUpdater.updateURDFJointAxis(updated, 'arm_joint', [0, 1, 0]);

    const joint = XMLUpdater.findNamedBlock(updated, 'joint', 'arm_joint').content;
    assert.ok(joint.indexOf('<origin') < joint.indexOf('<parent'));
    assert.ok(joint.indexOf('<axis') > joint.indexOf('<child'));
    assert.ok(joint.indexOf('<axis') < joint.indexOf('<limit'));
    assert.match(joint, /<origin xyz="0 0 0\.5" rpy="0 0 1\.2"\/>/);
    assert.match(joint, /<axis xyz="0 1 0"\/>/);
});

test('supports single-quoted names and updates an existing axis', () => {
    const xml = `<robot name='r'>
  <link name='a'></link>
  <link name='b'></link>
  <joint type='prismatic' name='slide'>
    <parent link='a'/><child link='b'/><axis xyz='1 0 0'/>
  </joint>
</robot>`;
    const updated = XMLUpdater.updateURDFJointAxis(xml, 'slide', [0, 0, -1]);

    assert.match(updated, /<axis xyz="0 0 -1"\/>/);
});

test('reverses joint limits when an axis direction is reversed', () => {
    const xml = URDF.replace(
        '<limit lower="-1" upper="1" effort="1" velocity="1"/>',
        '<limit lower="-1" upper="2" effort="8" velocity="3" damping="0.2"/>'
    );
    const updated = XMLUpdater.reverseURDFJointLimits(xml, 'arm_joint');

    assert.match(
        updated,
        /<limit lower="-2" upper="1" effort="8" velocity="3" damping="0\.2"\/>/
    );
});

test('reverses single-quoted limits regardless of attribute order and ignores comments', () => {
    const xml = `<robot name="limits">
  <joint type='revolute' name='active'>
    <!-- <limit lower='-9' upper='9' effort='1' velocity='1'/> -->
    <limit velocity='4' upper='3.5' effort='2' lower='-0.25'/>
  </joint>
</robot>`;
    const updated = XMLUpdater.reverseURDFJointLimits(xml, 'active');

    assert.match(updated, /<!-- <limit lower='-9' upper='9' effort='1' velocity='1'\/> -->/);
    assert.match(updated, /<limit velocity='4' upper="0\.25" effort='2' lower="-3\.5"\/>/);
});

test('does not reverse limits when the joint or finite range is missing', () => {
    const missingUpper = URDF.replace(' upper="1"', '');

    assert.equal(XMLUpdater.reverseURDFJointLimits(URDF, 'missing'), URDF);
    assert.equal(XMLUpdater.reverseURDFJointLimits(missingUpper, 'arm_joint'), missingUpper);
});

test('returns the original XML when the requested target does not exist', () => {
    assert.equal(
        XMLUpdater.updateURDFGeometryOrigin(
            URDF,
            'missing',
            'visual',
            0,
            { xyz: [0, 0, 0], rpy: [0, 0, 0] }
        ),
        URDF
    );
});

test('ignores commented-out geometry and axis tags when selecting an element', () => {
    const xml = `<robot name="comments">
  <!-- <link name="part"><visual><geometry><box size="9 9 9"/></geometry></visual></link> -->
  <link name="part">
    <!-- <visual><origin xyz="9 9 9"/><geometry><box size="9 9 9"/></geometry></visual> -->
    <visual><geometry><mesh filename="active.stl"/></geometry></visual>
  </link>
  <joint name="drive" type="continuous">
    <parent link="world"/><child link="part"/>
    <!-- <axis xyz="1 0 0"/> -->
  </joint>
</robot>`;

    let updated = XMLUpdater.updateURDFGeometryOrigin(
        xml,
        'part',
        'visual',
        0,
        { xyz: [1, 2, 3], rpy: [0, 0, 0] }
    );
    updated = XMLUpdater.updateURDFJointAxis(updated, 'drive', [0, 1, 0]);

    assert.match(updated, /<!-- <visual><origin xyz="9 9 9"/);
    assert.match(updated, /<visual>\s*<origin xyz="1 2 3" rpy="0 0 0"\/>/);
    assert.match(updated, /<!-- <axis xyz="1 0 0"\/> -->/);
    assert.match(updated, /<axis xyz="0 1 0"\/>/);
});

test('ignores a commented mesh tag when updating active mesh scale', () => {
    const xml = `<robot name="mesh_comments">
  <link name="part">
    <visual>
      <geometry>
        <!-- <mesh filename="old.stl" scale="9 9 9"/> -->
        <mesh filename="active.stl"/>
      </geometry>
    </visual>
  </link>
</robot>`;
    const updated = XMLUpdater.updateURDFMeshScale(xml, 'part', 'visual', 0, [1, -1, 1]);

    assert.match(updated, /<!-- <mesh filename="old\.stl" scale="9 9 9"\/> -->/);
    assert.match(updated, /<mesh filename="active\.stl" scale="1 -1 1"\/>/);
});
