import test from 'node:test';
import assert from 'node:assert/strict';
import { URDFJoint, URDFMimicJoint } from 'urdf-loader/src/URDFClasses.js';
import { JointControlsUI } from '../../src/ui/JointControlsUI.js';
import { UnifiedRobotModel, Joint } from '../../src/models/UnifiedRobotModel.js';

function makeModel() {
    const model = new UnifiedRobotModel();
    model.name = 'mixed-joints';
    for (const [name, type, value] of [
        ['rotation', 'revolute', 0.123456789012345],
        ['fixed', 'fixed', 0],
        ['slide', 'prismatic', 0.025432109876543],
        ['spin', 'continuous', -2.34567890123456]
    ]) {
        const joint = new Joint(name, type);
        joint.threeObject = new URDFJoint();
        joint.threeObject.jointType = type;
        joint.threeObject.ignoreLimits = true;
        joint.threeObject.setJointValue(value);
        joint.currentValue = value;
        model.addJoint(joint);
    }
    return model;
}

test('pose export preserves control order, names and precision in radians/meters', () => {
    const ui = new JointControlsUI({});
    const model = makeModel();
    const pose = JSON.parse(JSON.stringify(ui.getCurrentPose(model)));
    assert.equal(pose.model, 'mixed-joints');
    assert.deepEqual(pose.units, { rotation: 'rad', translation: 'm' });
    assert.deepEqual(pose.jointNames, ['rotation', 'slide', 'spin']);
    assert.deepEqual(pose.positions, [0.123456789012345, 0.025432109876543, -2.34567890123456]);
    model.joints.get('rotation').threeObject.setJointValue(0.987654321);
    assert.equal(ui.getCurrentPose(model).positions[0], 0.987654321);
    assert.equal(pose.positions[0], 0.123456789012345);
});

test('degrees/millimeters export restores a mixed-joint pose through the vector input', t => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { querySelector: () => null }
    });
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globalThis.document;
    });
    const ui = new JointControlsUI({ redraw() {}, render() {} });
    ui.angleUnit = 'deg';
    const model = makeModel();
    const pose = ui.getCurrentPose(model);
    assert.deepEqual(pose.units, { rotation: 'deg', translation: 'mm' });
    assert.equal(pose.positions[0], 0.123456789012345 * 180 / Math.PI);
    assert.equal(pose.positions[1], 25.432109876543);
    for (const joint of model.joints.values()) {
        joint.currentValue = 0;
        joint.threeObject.setJointValue(0);
    }
    assert.deepEqual(ui.setAllJoints(model, JSON.stringify(pose.positions)), { success: true });
    const restored = ui.getCurrentPose(model);
    restored.positions.forEach((value, i) => {
        assert.ok(Math.abs(value - pose.positions[i]) < 1e-12);
    });
    assert.ok(Math.abs(model.joints.get('slide').currentValue - 0.025432109876543) < 1e-15);
});

test('pose export captures a mimic follower from the rendered URDF joint', () => {
    const ui = new JointControlsUI({});
    const model = makeModel();
    const follower = new Joint('follower', 'revolute');
    follower.threeObject = new URDFMimicJoint();
    follower.threeObject.jointType = 'revolute';
    follower.threeObject.ignoreLimits = true;
    follower.threeObject.multiplier = -2;
    follower.threeObject.offset = 0.1;
    model.addJoint(follower);
    const driver = model.joints.get('rotation').threeObject;
    driver.mimicJoints.push(follower.threeObject);
    driver.setJointValue(0.4);
    assert.equal(follower.currentValue, 0);
    assert.ok(Math.abs(ui.getCurrentPose(model).positions.at(-1) + 0.7) < 1e-12);
});

test('pose export reports no pose for an unloaded or fixed-only model', () => {
    const ui = new JointControlsUI({});
    assert.equal(ui.getCurrentPose(null), null);
    const model = new UnifiedRobotModel();
    assert.equal(ui.getCurrentPose(model), null);
    model.addJoint(new Joint('fixed', 'fixed'));
    assert.equal(ui.getCurrentPose(model), null);
});
