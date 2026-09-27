import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseController } from '../../src/animation/runtime/PoseController.js';

function makePoseController() {
    let renders = 0;
    let measurements = 0;
    const sceneManager = {
        redraw: () => renders++,
        onMeasurementUpdate: () => measurements++,
        ignoreLimits: false
    };
    const joint = name => ({
        name, type: 'revolute', currentValue: 0,
        threeObject: { setJointValue(value) { this.jointValue = [value]; } }
    });
    const joints = new Map([['a', joint('a')], ['b', joint('b')]]);
    const model = {
        joints,
        getJoint: name => joints.get(name),
        threeObject: { updateMatrixWorld() {} }
    };
    const controller = new PoseController(sceneManager);
    controller.setModel(model);
    return { controller, counts: () => ({ renders, measurements }) };
}

test('multi-joint previews render once and commit as one pose event', () => {
    const { controller, counts } = makePoseController();
    const events = [];
    controller.subscribe(event => events.push(event));
    const applied = controller.applyJointValues({ a: 0.2, b: -0.3 });
    assert.deepEqual(applied, { a: 0.2, b: -0.3 });
    assert.deepEqual(counts(), { renders: 1, measurements: 1 });
    assert.equal(events.filter(event => event.type === 'jointChanged').length, 2);
    assert.equal(events.filter(event => event.type === 'poseChanged' && !event.commit).length, 1);
    controller.commitJointValues(['a', 'b']);
    const commits = events.filter(event => event.commit);
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].values, { a: 0.2, b: -0.3 });
});

test('live lock rejects multi-joint previews and commits', () => {
    const { controller, counts } = makePoseController();
    const events = [];
    controller.subscribe(event => events.push(event));
    controller.liveLocked = true;
    assert.equal(controller.applyJointValues({ a: 0.5 }), null);
    controller.commitJointValues(['a']);
    assert.equal(controller.getJointValue('a'), 0);
    assert.deepEqual(counts(), { renders: 0, measurements: 0 });
    assert.deepEqual(events, []);
});
