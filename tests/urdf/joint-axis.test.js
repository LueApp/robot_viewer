import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D, Quaternion, Scene, Vector3 } from 'three';

import { Joint, UnifiedRobotModel } from '../../src/models/UnifiedRobotModel.js';
import { CoordinateAxesManager } from '../../src/renderer/CoordinateAxesManager.js';
import { CopiedFrameManager } from '../../src/renderer/CopiedFrameManager.js';

function fixture(type = 'revolute') {
    const model = new UnifiedRobotModel();
    const drive = new Joint('drive', type);
    drive.parent = 'base';
    drive.child = 'arm_frame_base';
    drive.threeObject = new Object3D();
    drive.threeObject.position.set(1, -2, 3);
    drive.threeObject.rotation.set(0.2, -0.4, 0.7);
    drive.threeObject.axis = new Vector3(1, -2, 3).normalize();
    const helper = new Joint('arm_frame_adjustment', 'fixed');
    helper.parent = drive.child;
    helper.child = 'arm';
    helper.threeObject = new Object3D();
    helper.threeObject.position.set(0.3, -0.2, 0.5);
    helper.threeObject.rotation.set(0.4, -0.7, 1.2);
    helper.threeObject.urdfNode = { childNodes: [{ nodeType: 8, nodeValue: ' robot-viewer: link-frame-adjustment ' }] };
    drive.threeObject.add(helper.threeObject);
    model.addJoint(drive);
    model.addJoint(helper);
    const sceneManager = { currentModel: model, scene: new Scene(), redraw() {} };
    sceneManager.scene.add(drive.threeObject);
    const axes = new CoordinateAxesManager(sceneManager);
    sceneManager.axesManager = axes;
    axes.createJointAxis(drive, drive.name);
    return { model, drive, helper, axes, sceneManager };
}

test('older adjusted links retain access to their original revolute or continuous axis', () => {
    for (const type of ['revolute', 'continuous']) {
        const { model, axes } = fixture(type);
        assert.equal(axes.hasJointAxis('arm', model), true);
        assert.equal(axes.hasJointAxis('arm_frame_base', model), true);
        assert.equal(axes.hasJointAxis('base', model), false);
    }
});

test('axis toggles and global visibility follow the original physical joint', () => {
    const { model, drive, helper, axes } = fixture();
    const info = axes.jointAxesHelpers.get(drive.name);
    axes.toggleLinkJointAxis('arm', true, model);
    assert.equal(info.mesh.parent, drive.threeObject);
    assert.equal(info.isAttached, true);
    assert.equal(axes.isLinkJointAxisVisible('arm', model), true);
    assert.equal(axes.isLinkJointAxisVisible('arm_frame_base', model), true);
    assert.ok(info.mesh.getWorldPosition(new Vector3()).distanceTo(drive.threeObject.getWorldPosition(new Vector3())) < 1e-12);
    assert.ok(info.mesh.getWorldPosition(new Vector3()).distanceTo(helper.threeObject.getWorldPosition(new Vector3())) > 0.1);
    const actualDirection = new Vector3(0, 1, 0).applyQuaternion(info.mesh.children[0].getWorldQuaternion(new Quaternion()));
    const expectedDirection = drive.threeObject.axis.clone().applyQuaternion(drive.threeObject.getWorldQuaternion(new Quaternion()));
    assert.ok(actualDirection.distanceTo(expectedDirection) < 1e-12);

    axes.showAllJointAxes();
    axes.hideAllJointAxes();
    assert.equal(info.isAttached, true, 'global off respects the adjusted-link override');
    axes.showOnlyJointAxis({});
    assert.equal(info.isAttached, false);
    axes.restoreAllJointAxes();
    assert.equal(info.isAttached, true, 'restore respects the adjusted-link override');
    axes.toggleLinkJointAxis('arm', false, model);
    assert.equal(info.isAttached, false);
    assert.equal(axes.isLinkJointAxisVisible('arm', model), false);
});

test('overrides on adjusted and helper links share visibility of one physical axis', () => {
    const { model, drive, axes } = fixture();
    const info = axes.jointAxesHelpers.get(drive.name);
    axes.toggleLinkJointAxis('arm', true, model);
    axes.toggleLinkJointAxis('arm_frame_base', true, model);
    axes.toggleLinkJointAxis('arm', false, model);
    assert.equal(info.isAttached, true);
    assert.equal(axes.isLinkJointAxisVisible('arm', model), true);
    axes.toggleLinkJointAxis('arm_frame_base', false, model);
    assert.equal(info.isAttached, false);
});

test('ordinary fixed links and adjusted prismatic links do not inherit a revolute axis', () => {
    const { model, helper, axes } = fixture();
    helper.threeObject.urdfNode = { childNodes: [] };
    assert.equal(axes.hasJointAxis('arm', model), false);
    const prismatic = fixture('prismatic');
    assert.equal(prismatic.axes.hasJointAxis('arm', prismatic.model), false);
    assert.equal(axes.hasJointAxis('missing', model), false);
    assert.equal(axes.hasJointAxis('arm', null), false);
});

test('nested legacy helper frames resolve to the driving joint and cycles stop safely', () => {
    const { model, drive, helper, axes } = fixture();
    const nested = new Joint('nested_adjustment', 'fixed');
    nested.parent = 'arm';
    nested.child = 'nested_frame';
    nested.threeObject = new Object3D();
    nested.threeObject.urdfNode = helper.threeObject.urdfNode;
    model.addJoint(nested);
    assert.equal(CoordinateAxesManager.findLinkRotationJoint('nested_frame', model), drive);
    axes.toggleLinkJointAxis('nested_frame', true, model);
    assert.equal(axes.jointAxesHelpers.get(drive.name).isAttached, true);
    helper.parent = 'nested_frame';
    assert.equal(axes.hasJointAxis('nested_frame', model), false);
});

test('copying an adjusted link axis copies its original joint origin and direction', () => {
    const { model, drive, sceneManager } = fixture();
    const copies = new CopiedFrameManager(sceneManager);
    copies._ensurePanel = () => {};
    copies._addFrameEntry = () => {};
    copies.selectFrame = () => {};
    copies.copyJointAxis('arm', model);
    assert.equal(copies.copiedFrames.size, 1);
    const copy = [...copies.copiedFrames.values()][0];
    assert.equal(copy.sourceJointName, drive.name);
    assert.equal(copy.sourceLinkName, 'arm');
    assert.ok(copy.originalWorldPosition.distanceTo(drive.threeObject.getWorldPosition(new Vector3())) < 1e-12);
    const actualDirection = new Vector3(0, 1, 0).applyQuaternion(copy.threeObject.children[0].getWorldQuaternion(new Quaternion()));
    const expectedDirection = drive.threeObject.axis.clone().applyQuaternion(drive.threeObject.getWorldQuaternion(new Quaternion()));
    assert.ok(actualDirection.distanceTo(expectedDirection) < 1e-12);
});
