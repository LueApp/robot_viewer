import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationStore } from '../../src/animation/core/AnimationStore.js';
import { evaluateClip } from '../../src/animation/core/BezierEvaluator.js';

const EXAMPLE_URL = new URL('../../examples/dake-run-hop-adventure.robotanim.json', import.meta.url);

test('loads the long g3 达克 example and keeps its choreography within model limits', () => {
    const store = new AnimationStore();
    store.load(readFileSync(EXAMPLE_URL, 'utf8'));
    const clip = store.activeClip;
    const jointTracks = clip.tracks.filter((track) => track.type === 'joint');

    assert.equal(clip.name, '达克 · 跑跳小冒险');
    assert.equal(clip.durationMs, 20000);
    assert.equal(clip.loop, true);
    assert.equal(jointTracks.length, 16);
    assert.equal(clip.tracks.filter((track) => track.type === 'event').length, 5);
    assert.equal(clip.markers.length, 20);
    assert.equal(store.project.poseAssets.length, 10);

    const neutral = evaluateClip(clip, 0);
    const loopEnd = evaluateClip(clip, clip.durationMs);
    assert.deepEqual(loopEnd, neutral);

    const firstStride = evaluateClip(clip, 2000);
    const secondStride = evaluateClip(clip, 2300);
    assert.ok(firstStride.R_hip_pitch_joint > 0 && firstStride.L_hip_pitch_joint < 0);
    assert.ok(secondStride.R_hip_pitch_joint < 0 && secondStride.L_hip_pitch_joint > 0);

    const jumpLoad = evaluateClip(clip, 10000);
    const jumpLaunch = evaluateClip(clip, 10333.333);
    const airTuck = evaluateClip(clip, 10700);
    const landing = evaluateClip(clip, 11000);
    assert.ok(jumpLoad.R_knee_pitch_joint > 0.9);
    assert.ok(jumpLaunch.R_knee_pitch_joint < 0);
    assert.ok(airTuck.R_knee_pitch_joint > 0.8);
    assert.ok(landing.R_knee_pitch_joint > 1);

    let previous = neutral;
    for (let frame = 1; frame <= 600; frame += 1) {
        const current = evaluateClip(clip, frame * 1000 / 30);
        jointTracks.forEach((track) => {
            const value = current[track.jointName];
            assert.ok(value >= track.valueRange.lower && value <= track.valueRange.upper);
            const speed = Math.abs(value - previous[track.jointName]) * 30;
            assert.ok(speed <= track.valueRange.velocity, `${track.jointName} exceeds its velocity limit`);
        });
        previous = current;
    }
});
