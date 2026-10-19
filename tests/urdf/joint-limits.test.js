import assert from 'node:assert/strict';
import test from 'node:test';
import { URDFJoint, URDFLink, URDFRobot } from 'urdf-loader/src/URDFClasses.js';
import { URDFAdapter } from '../../src/adapters/URDFAdapter.js';

function fixture(type, lower, upper) {
    const robot = new URDFRobot();
    robot.name = 'limit_test';
    const child = new URDFLink();
    child.name = 'arm';
    const joint = new URDFJoint();
    joint.name = 'motor';
    joint.jointType = type;
    joint.limit = { lower, upper, effort: 20, velocity: 3 };
    joint.add(child);
    robot.add(joint);
    robot.links = { base: robot, arm: child };
    robot.joints = { motor: joint };
    return { robot, joint };
}

test('reversed revolute and prismatic limits allow motion through the corrected range', () => {
    for (const type of ['revolute', 'prismatic']) {
        for (const [lower, upper] of [[2, -1], [-1, -3], [3, 1]]) {
            const { robot, joint: native } = fixture(type, lower, upper);
            const model = URDFAdapter.convert(robot);
            const joint = model.getJoint('motor');
            assert.equal(joint.limits.lower, upper);
            assert.equal(joint.limits.upper, lower);
            assert.deepEqual(native.limit, { lower: upper, upper: lower, effort: 20, velocity: 3 });
            assert.equal(joint.limits.effort, 20);
            assert.equal(joint.limits.velocity, 3);

            // Exercise the same joint implementation used by the viewer.
            for (const value of [upper, (lower + upper) / 2, lower]) {
                URDFAdapter.setJointAngle(joint, value);
                assert.equal(native.angle, value);
                assert.equal(joint.currentValue, value);
                if (type === 'prismatic') {
                    assert.equal(native.position.x, value);
                } else {
                    assert.ok(Math.abs(native.rotation.x - value) < 1e-10);
                }
            }
            native.setJointValue(upper - 1);
            assert.equal(native.angle, upper);
            native.setJointValue(lower + 1);
            assert.equal(native.angle, lower);

            const reloaded = URDFAdapter.convert(robot).getJoint('motor');
            assert.equal(reloaded.limits.lower, upper);
            assert.equal(reloaded.limits.upper, lower);
        }
    }
});

test('valid, equal, and non-finite bounds are preserved', () => {
    for (const type of ['revolute', 'prismatic']) {
        for (const [lower, upper] of [[-2, 1], [1, 1], [NaN, -1], [1, NaN], [Infinity, -1], [1, -Infinity]]) {
            const { robot, joint: native } = fixture(type, lower, upper);
            const joint = URDFAdapter.convert(robot).getJoint('motor');
            assert.equal(joint.limits.lower, lower);
            assert.equal(joint.limits.upper, upper);
            assert.equal(native.limit.lower, lower);
            assert.equal(native.limit.upper, upper);
        }
    }
});

test('continuous and fixed joints do not gain positional constraints', () => {
    for (const type of ['continuous', 'fixed']) {
        const { robot, joint: native } = fixture(type, 1, -1);
        const joint = URDFAdapter.convert(robot).getJoint('motor');
        assert.equal(joint.limits.lower, 1);
        assert.equal(joint.limits.upper, -1);
        assert.equal(native.limit.lower, 1);
        assert.equal(native.limit.upper, -1);
        if (type === 'continuous') {
            URDFAdapter.setJointAngle(joint, 7);
            assert.equal(native.angle, 7);
        }
    }
});

test('normalization runs after XML has supplemented the limits', t => {
    const { robot, joint: native } = fixture('revolute', -1, 2);
    t.mock.method(URDFAdapter, 'parseInertialFromXML', () => ({}));
    t.mock.method(URDFAdapter, 'supplementJointLimitsFromXML', model => {
        Object.assign(model.getJoint('motor').limits, { lower: 2, upper: -1, effort: 40, velocity: 5 });
    });

    const joint = URDFAdapter.convert(robot, '<robot/>').getJoint('motor');
    assert.equal(joint.limits.lower, -1);
    assert.equal(joint.limits.upper, 2);
    assert.equal(joint.limits.effort, 40);
    assert.equal(joint.limits.velocity, 5);
    assert.equal(native.limit.lower, -1);
    assert.equal(native.limit.upper, 2);
});
