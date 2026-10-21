import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { URDFLink, URDFRobot } from 'urdf-loader/src/URDFClasses.js';
import { URDFAdapter } from '../../src/adapters/URDFAdapter.js';
import { InertialVisualization } from '../../src/renderer/InertialVisualization.js';

test('loader inertia tensors survive model conversion and create a visible inertia box', () => {
    const robot = new URDFRobot();
    robot.name = 'base_link';
    const arm = new URDFLink();
    arm.name = 'arm_link';
    const tensor = { ixx: 0.02, iyy: 0.03, izz: 0.04, ixy: -0.001, ixz: 0.002, iyz: -0.003 };
    Object.assign(arm.inertial, { mass: 2, origin: { xyz: [0.1, -0.2, 0.3], rpy: [0, 0, 0] }, inertia: { ...tensor } });
    robot.add(arm);
    robot.links = { base_link: robot, arm_link: arm };
    robot.joints = {};

    const model = URDFAdapter.convert(robot);
    const inertial = model.links.get('arm_link').inertial;
    assert.equal(inertial.mass, 2);
    assert.deepEqual(inertial.origin.xyz, [0.1, -0.2, 0.3]);
    for (const [name, value] of Object.entries(tensor)) assert.equal(inertial[name], value, name);

    const display = new InertialVisualization({ scene: new THREE.Scene() });
    display.toggleInertia(true, model);
    assert.equal(display.inertiaEllipsoids.size, 1);
    const box = display.inertiaEllipsoids.get('arm_link');
    assert.equal(box.parent, arm);
    assert.equal(box.visible, true);
    assert.deepEqual(box.position.toArray(), inertial.origin.xyz);
    for (const size of ['width', 'height', 'depth']) assert.ok(box.geometry.parameters[size] > 0);
    display.toggleInertia(false, model);
    assert.equal(box.visible, false);
    display.toggleLinkInertia('arm_link', true, model);
    assert.equal(box.visible, true);
    display.clear();
});

test('legacy flat inertia tensors remain supported without inventing missing components', () => {
    const inertial = URDFAdapter.convertInertial({ mass: 1, ixx: 0.001, iyy: 0.002, izz: 0.003, ixy: -0.0001 });
    assert.equal(inertial.ixx, 0.001);
    assert.equal(inertial.iyy, 0.002);
    assert.equal(inertial.izz, 0.003);
    assert.equal(inertial.ixy, -0.0001);
    assert.equal(inertial.ixz, 0);
    assert.equal(inertial.iyz, 0);
});
