import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EndEffectorIK } from '../../src/utils/EndEffectorIK.js';

function createArm(count = 3) {
    const root = new THREE.Group();
    const joints = new Map();
    const links = new Map();
    let parent = root;
    for (let i = 0; i < count; i++) {
        const jointObject = new THREE.Group();
        jointObject.name = `joint${i}`;
        parent.add(jointObject);
        const linkObject = new THREE.Group();
        linkObject.name = `link${i}`;
        linkObject.position.x = 1;
        jointObject.add(linkObject);
        joints.set(jointObject.name, {
            name: jointObject.name,
            type: 'revolute',
            currentValue: 0,
            threeObject: jointObject,
            limits: { lower: -Math.PI, upper: Math.PI }
        });
        links.set(linkObject.name, { name: linkObject.name, threeObject: linkObject });
        parent = linkObject;
    }
    const model = { threeObject: root, joints, links, constraints: new Map() };
    const setJoint = (joint, value) => joint.threeObject.rotation.z = value;
    const ik = new EndEffectorIK(model, { setJoint });
    const setPose = values => Object.entries(values).forEach(([name, value]) => {
        const joint = joints.get(name);
        setJoint(joint, value);
        joint.currentValue = value;
    });
    const end = links.get(`link${count - 1}`);
    return { model, ik, end, setPose };
}

test('position-only IK moves the end on an axis without changing the perpendicular coordinate', () => {
    const { ik, end, setPose } = createArm(2);
    setPose({ joint0: 0.5, joint1: -0.9 });
    const start = ik.readPose(end);
    const target = start.position.clone().add(new THREE.Vector3(-0.08, 0, 0));
    const result = ik.solve(end.name, target);
    assert.equal(result.supported, true);
    assert.ok(result.positionError < 0.002, `position error ${result.positionError}`);
    assert.ok(start.position.distanceTo(ik.readPose(end).position) < 1e-10, 'solver restores preview pose');
    setPose(result.values);
    const reached = ik.readPose(end).position;
    assert.ok(Math.abs(reached.x - target.x) < 0.002);
    assert.ok(Math.abs(reached.y - target.y) < 0.002);
});

test('pose IK reaches a position while preserving orientation', () => {
    const { ik, end, setPose } = createArm();
    setPose({ joint0: 0.7, joint1: -1.1, joint2: 0.4 });
    const start = ik.readPose(end);
    const target = start.position.clone().add(new THREE.Vector3(-0.06, 0.04, 0));
    const result = ik.solve(end.name, target, start.quaternion);
    assert.equal(result.supported, true);
    assert.ok(result.positionError < 0.002, `position error ${result.positionError}`);
    assert.ok(result.orientationError < 0.002, `orientation error ${result.orientationError}`);
    setPose(result.values);
    const reached = ik.readPose(end);
    assert.ok(reached.position.distanceTo(target) < 0.002);
    assert.ok(reached.quaternion.angleTo(start.quaternion) < 0.002);
});

test('a 0.01 mm prismatic nudge is resolved', () => {
    const root = new THREE.Group();
    const jointObject = new THREE.Group();
    jointObject.name = 'slide';
    const linkObject = new THREE.Group();
    linkObject.name = 'tip';
    root.add(jointObject);
    jointObject.add(linkObject);
    const joint = { name: 'slide', type: 'prismatic', currentValue: 0, threeObject: jointObject };
    const model = {
        threeObject: root,
        joints: new Map([['slide', joint]]),
        links: new Map([['tip', { name: 'tip', threeObject: linkObject }]])
    };
    const ik = new EndEffectorIK(model, { setJoint: (_, value) => jointObject.position.x = value });
    const result = ik.solve('tip', new THREE.Vector3(0.00001, 0, 0));
    assert.equal(result.supported, true);
    assert.ok(result.values.slide > 0.000009, `resolved displacement ${result.values.slide}`);
    assert.ok(result.positionError < 0.000001);
});

test('IK reports residual for unreachable targets and respects joint limits', () => {
    const { ik, model, end, setPose } = createArm(2);
    model.joints.get('joint0').limits = { lower: 0, upper: 0 };
    const target = new THREE.Vector3(0, 2, 0);
    const result = ik.solve(end.name, target);
    assert.equal(result.supported, true);
    assert.equal(result.reached, false);
    assert.equal(result.values.joint0, 0);
    assert.ok(result.positionError > 0.1);
    setPose(result.values);
    assert.equal(model.joints.get('joint0').currentValue, 0);
});

test('hold weights prefer free joints and 100% locks a joint exactly', () => {
    const { ik, end, setPose } = createArm();
    const initial = { joint0: 0.7, joint1: -1.1, joint2: 0.4 };
    setPose(initial);
    const target = ik.readPose(end).position.add(new THREE.Vector3(-0.06, 0.04, 0));

    const free = ik.solve(end.name, target);
    const weighted = ik.solve(end.name, target, null, { jointWeights: [0.9, 0, 0] });
    const locked = ik.solve(end.name, target, null, { jointWeights: [1, 0, 0] });
    assert.ok(free.reached && weighted.reached && locked.reached);
    assert.ok(Math.abs(weighted.values.joint0 - initial.joint0) <
        Math.abs(free.values.joint0 - initial.joint0) / 2);
    assert.equal(locked.values.joint0, initial.joint0);
    assert.ok(ik.readPose(end).position.distanceTo(target) > 0.05, 'solver restores the initial pose');
});

test('a fully locked chain cannot move and invalid weight vectors are rejected', () => {
    const { ik, end, setPose } = createArm(2);
    setPose({ joint0: 0.5, joint1: -0.7 });
    const target = ik.readPose(end).position.add(new THREE.Vector3(0.02, 0, 0));
    const result = ik.solve(end.name, target, null, { jointWeights: [1, 1] });
    assert.equal(result.supported, true);
    assert.equal(result.reached, false);
    assert.deepEqual(result.values, { joint0: 0.5, joint1: -0.7 });
    assert.equal(ik.solve(end.name, target, null, { jointWeights: [0] }).supported, false);
    assert.equal(ik.solve(end.name, target, null, { jointWeights: [0, 1.1] }).supported, false);
});
