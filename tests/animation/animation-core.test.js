import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationStore } from '../../src/animation/core/AnimationStore.js';
import { EditorSelection } from '../../src/animation/core/EditorSelection.js';
import { evaluateClip, evaluateTrack } from '../../src/animation/core/BezierEvaluator.js';
import { PlaybackController } from '../../src/animation/runtime/PlaybackController.js';

function createModel() {
    return {
        joints: new Map([
            ['fixed', { type: 'fixed', currentValue: 0 }],
            ['shoulder', { type: 'revolute', currentValue: 0 }],
            ['wrist', { type: 'continuous', currentValue: 0 }]
        ])
    };
}

test('evaluates step, linear and cubic keyframe segments', () => {
    const track = {
        keyframes: [
            { timeMs: 0, value: 0, interpolation: 'linear' },
            { timeMs: 1000, value: 1, interpolation: 'linear' }
        ]
    };
    assert.equal(evaluateTrack(track, -1), 0);
    assert.equal(evaluateTrack(track, 500), 0.5);
    assert.equal(evaluateTrack(track, 1200), 1);
    track.keyframes[0].interpolation = 'step';
    assert.equal(evaluateTrack(track, 500), 0);
    track.keyframes[0].interpolation = 'broken';
    track.keyframes[0].outHandle = { dxMs: 300, dy: 0 };
    track.keyframes[1].inHandle = { dxMs: -300, dy: 0 };
    assert.ok(Math.abs(evaluateTrack(track, 500) - 0.5) < 0.0001);
});

test('creates frame-snapped keys and evaluates only enabled joint tracks', () => {
    const store = new AnimationStore();
    store.setModel(createModel(), 'Test Robot');
    assert.deepEqual(store.activeClip.tracks.map((track) => track.jointName), ['shoulder', 'wrist']);

    const first = store.upsertKeyframe('shoulder', 1001, 0.25);
    const same = store.upsertKeyframe('shoulder', 1000, 0.5);
    assert.equal(first.id, same.id);
    assert.equal(first.timeMs, 1000);
    store.upsertKeyframe('shoulder', 2000, 1);
    assert.ok(Number.isFinite(first.outHandle.dxMs));

    const media = store.addMediaAsset({
        name: 'test.wav',
        kind: 'audio',
        durationMs: 1000,
        dataUrl: 'data:audio/wav;base64,AA=='
    });
    store.addMediaTrack(media.id, 0);
    assert.deepEqual(Object.keys(evaluateClip(store.activeClip, 1500)), ['shoulder']);

    store.setTrackProperty(store.getTrack('shoulder').id, 'muted', true);
    assert.deepEqual(evaluateClip(store.activeClip, 1500), {});
});

test('groups drag edits into one undo operation and supports redo', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    const key = store.upsertKeyframe('shoulder', 1000, 0.5);
    const track = store.getTrack('shoulder');
    const ref = { trackId: track.id, keyframeId: key.id };
    const originals = [{ ...ref, timeMs: key.timeMs, value: key.value }];
    store.beginTransaction('Drag key');
    store.moveKeyframesFrom(originals, 1000, 0.25);
    store.moveKeyframesFrom(originals, 2000, 0.5);
    store.endTransaction();
    assert.equal(store.getKeyframe(ref).keyframe.timeMs, 3000);
    assert.equal(store.getKeyframe(ref).keyframe.value, 1);
    assert.equal(store.undo(), true);
    assert.equal(store.getKeyframe(ref).keyframe.timeMs, 1000);
    assert.equal(store.redo(), true);
    assert.equal(store.getKeyframe(ref).keyframe.timeMs, 3000);
});

test('copies multiple tracks with relative timing and pastes at the playhead', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    const shoulderKey = store.upsertKeyframe('shoulder', 1000, 0.2);
    const wristKey = store.upsertKeyframe('wrist', 1500, -0.4);
    const payload = store.copyKeyframes([
        { trackId: store.getTrack('shoulder').id, keyframeId: shoulderKey.id },
        { trackId: store.getTrack('wrist').id, keyframeId: wristKey.id }
    ]);
    const created = store.pasteKeyframes(payload, 3000);
    assert.equal(created.length, 2);
    assert.deepEqual(store.getTrack('shoulder').keyframes.map((key) => key.timeMs), [1000, 3000]);
    assert.deepEqual(store.getTrack('wrist').keyframes.map((key) => key.timeMs), [1500, 3500]);
});

test('manages animations, markers, play range and duration', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    store.upsertKeyframe('shoulder', 8000, 1);
    const marker = store.addMarker(4000, 'Beat');
    store.setPlayRange(1000, 6000);
    assert.deepEqual(store.activeClip.playRange, { startMs: 1000, endMs: 6000 });
    assert.equal(marker.name, 'Beat');

    const duplicate = store.duplicateAnimation();
    assert.equal(store.project.clips.length, 2);
    assert.match(duplicate.name, /Copy/);
    store.renameAnimation('Wave');
    assert.equal(store.activeClip.name, 'Wave');
    store.setDuration(5000);
    assert.equal(store.activeClip.tracks[0].keyframes.length, 0);
    assert.equal(store.deleteAnimation(), true);
    assert.equal(store.project.clips.length, 1);
    store.setDuration(99 * 60 * 60 * 1000);
    assert.equal(store.activeClip.durationMs, 4 * 60 * 60 * 1000);
});

test('serializes v2 projects and migrates v1 files', () => {
    const store = new AnimationStore();
    store.setModel(createModel(), 'Serializable');
    store.upsertKeyframe('shoulder', 1000, 0.5);
    const restored = new AnimationStore();
    restored.load(store.serialize());
    assert.equal(restored.project.schemaVersion, 2);
    assert.equal(restored.project.robot.name, 'Serializable');

    const legacy = {
        schemaVersion: 1,
        robot: { name: 'Legacy' },
        activeClipId: 'clip-1',
        clips: [{
            id: 'clip-1', name: 'Old', durationMs: 5000, fps: 30, loop: true,
            tracks: [{
                id: 'track-1', jointName: 'shoulder',
                keyframes: [{ id: 'key-1', timeMs: 0, value: 0, interpolation: 'bezier' }]
            }]
        }]
    };
    restored.load(legacy);
    assert.equal(restored.project.schemaVersion, 2);
    assert.equal(restored.getTrack('shoulder').keyframes[0].interpolation, 'auto');
    assert.deepEqual(restored.activeClip.playRange, { startMs: 0, endMs: 5000 });
});

test('tracks multi-selection and toggle selection', () => {
    const selection = new EditorSelection();
    const first = { trackId: 'a', keyframeId: '1' };
    const second = { trackId: 'b', keyframeId: '2' };
    selection.selectKeyframe(first);
    selection.selectKeyframe(second, { additive: true });
    assert.equal(selection.getKeyframeRefs().length, 2);
    selection.selectKeyframe(first, { toggle: true });
    assert.deepEqual(selection.getKeyframeRefs(), [second]);
    selection.clear();
    assert.equal(selection.trackIds.size, 0);
});

test('playback seek honors suppressed tracks while recording', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    store.upsertKeyframe('shoulder', 0, 0);
    store.upsertKeyframe('shoulder', 1000, 1);
    store.upsertKeyframe('wrist', 0, 0);
    store.upsertKeyframe('wrist', 1000, -1);
    let applied = null;
    const playback = new PlaybackController(store, { applyPose: (pose) => { applied = pose; } });
    playback.suppressedJointNames.add('shoulder');
    playback.seek(500);
    assert.equal('shoulder' in applied, false);
    assert.ok(Math.abs(applied.wrist + 0.5) < 0.001);
});

test('rejects invalid animation documents', () => {
    const store = new AnimationStore();
    assert.throws(() => store.load('{"schemaVersion":99,"clips":[]}'));
    assert.throws(() => store.load('{"schemaVersion":2,"clips":[]}'));
});

test('supports event tracks, editable event keys and runtime event dispatch', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    const eventTrack = store.addEventTrack('Eyes On', 'boolean');
    const key = store.addEventKeyframe(eventTrack.id, 1000, true);
    store.updateKeyframe({ trackId: eventTrack.id, keyframeId: key.id }, { value: false });
    assert.equal(eventTrack.keyframes[0].value, false);

    const received = [];
    const playback = new PlaybackController(store, { applyPose: () => {} });
    playback.subscribeEvents((detail) => received.push(detail));
    playback.dispatchEvents(0, 1200);
    assert.equal(received.length, 1);
    assert.equal(received[0].name, 'Eyes On');
    assert.equal(received[0].value, false);

    const numberTrack = store.addEventTrack('Intensity', 'number');
    store.addEventKeyframe(numberTrack.id, 0, 0);
    store.addEventKeyframe(numberTrack.id, 1000, 1);
    playback.seek(500);
    assert.equal(received.at(-1).name, 'Intensity');
    assert.ok(Math.abs(received.at(-1).value - 0.5) < 0.001);
    assert.equal(received.at(-1).continuous, true);
});

test('stores recording range and reusable pose snapshots', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    store.setRecordRange(1000, 4000);
    const pose = store.savePose('Ready', { shoulder: 0.4, wrist: -0.2, missing: 9 });
    assert.deepEqual(store.activeClip.recordRange, { startMs: 1000, endMs: 4000 });
    assert.deepEqual(pose.values, { shoulder: 0.4, wrist: -0.2 });
    assert.equal(store.deletePose(pose.id), true);
    assert.equal(store.project.poseAssets.length, 0);
});

test('generates a replaceable range of numeric keyframes in one operation', () => {
    const store = new AnimationStore();
    store.setModel(createModel());
    const track = store.getTrack('shoulder');
    store.upsertKeyframe('shoulder', 250, 1);
    const refs = store.generateTrackKeyframes(track.id, [
        { timeMs: 0, value: 0 },
        { timeMs: 500, value: 0.5 },
        { timeMs: 1000, value: 1 }
    ], { startMs: 0, endMs: 1000, replace: true });
    assert.equal(refs.length, 3);
    assert.deepEqual(track.keyframes.map((keyframe) => keyframe.timeMs), [0, 500, 1000]);
    assert.deepEqual(track.keyframes.map((keyframe) => keyframe.value), [0, 0.5, 1]);
    assert.equal(store.undo(), true);
    assert.deepEqual(store.getTrack('shoulder').keyframes.map((keyframe) => keyframe.timeMs), [233.333]);
});
