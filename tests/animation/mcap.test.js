import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { compress as lz4Compress } from 'lz4-lite';
import { parse } from '@foxglove/rosmsg';
import { MessageWriter as Ros1Writer } from '@foxglove/rosmsg-serialization';
import { MessageWriter as Ros2Writer } from '@foxglove/rosmsg2-serialization';
import { inspectMcap, readMcapTopics, makeMcapRecording } from '../../src/integrations/McapRecording.js';
import { LiveRecording, recordedClipData } from '../../src/integrations/LiveState.js';
import { encoderTopic, mcapFile } from '../fixtures/mcap.mjs';

const model = { name: 'test', joints: new Map([['hinge', { type: 'continuous' }], ['slide', { type: 'prismatic' }]]) };
const encoderRule = { names: 'feedback.labels', positions: 'feedback.degrees', unit: 'deg' };

for (const [format, compress] of [['unchunked', null], ['lz4', lz4Compress], ['zstd', zlib.zstdCompressSync]]) {
    test(`MCAP ${format} maps two topics with overlapping names and preserves nanosecond deltas`,
        { skip: format === 'zstd' && !compress }, async () => {
        const epoch = 1750000000000000000n;
        const feedback = value => ({ feedback: { labels: ['shaft'], degrees: [value] } });
        const topics = [
            { topic: '/arm', messages: [[epoch + 1n, feedback(90)], [epoch, feedback(0)]] },
            { topic: '/rail', messages: [[epoch, { name: ['shaft'], position: [20] }], [epoch + 2n, { name: ['shaft'], position: [] }]] },
            { topic: '/camera', encoding: 'protobuf', messages: [[epoch, Uint8Array.of(1)]] },
        ];
        const file = await mcapFile(topics, { useChunks: Boolean(compress),
            compressChunk: compress && (chunk => ({ compression: format, compressedData: compress(chunk) })) });
        const channels = await inspectMcap(file);
        assert.match(channels[2].error, /Unsupported/);
        assert.ok(channels[0].positions.includes(encoderRule.positions));
        const [arm, rail] = channels.map(c => c.id);
        const rules = new Map([[arm, encoderRule], [rail, { names: 'name', positions: 'position', unit: 'mm' }]]);
        const prepared = await readMcapTopics(file, channels, rules);
        const targets = new Map([[arm, new Map([['shaft', 'hinge']])], [rail, new Map([['shaft', 'slide']])]]);
        const recording = makeMcapRecording(prepared, targets, model, 'motion.mcap');
        const segment = LiveRecording.load(recording.data).data.segments[0];
        assert.deepEqual(segment.samples.map(s => s.simulation_time), [0, 1e-9]);
        assert.deepEqual(segment.samples[1].joints, { hinge: { position: Math.PI / 2, unit: 'rad' }, slide: { position: 0.02, unit: 'm' } });
        assert.equal(recordedClipData(segment, model).tracks.length, 2);
        targets.get(rail).set('shaft', 'hinge');
        assert.throws(() => makeMcapRecording(prepared, targets, model, 'motion.mcap'), /Multiple sources/);
        targets.get(arm).clear();
        assert.throws(() => makeMcapRecording(prepared, targets, model, 'motion.mcap'), /incompatible/);
    });
}

for (const ros2 of [true, false]) {
    test(`ROS ${ros2 ? '2' : '1'} JointState works with an empty schema definition`, async () => {
        const encoding = ros2 ? 'cdr' : 'ros1';
        const definition = 'std_msgs/Header header\nstring[] name\nfloat64[] position\nfloat64[] velocity\nfloat64[] effort\n===\nMSG: std_msgs/Header\n' +
            (ros2 ? '' : 'uint32 seq\n') + 'time stamp\nstring frame_id';
        const Writer = ros2 ? Ros2Writer : Ros1Writer;
        const writer = new Writer(parse(definition, { ros2 }));
        const data = writer.writeMessage({ header: { seq: 0, stamp: { sec: 0, nsec: 0, nanosec: 0 }, frame_id: 'base' },
            name: ['hinge'], position: [0.75], velocity: [], effort: [] });
        const file = await mcapFile([{ topic: '/robot/measured', encoding, schema: {
            name: ros2 ? 'sensor_msgs/msg/JointState' : 'sensor_msgs/JointState', encoding: ros2 ? 'ros2msg' : 'ros1msg', data: '',
        }, messages: [[20n, data]] }]);
        const channels = await inspectMcap(file);
        const id = channels[0].id;
        const prepared = await readMcapTopics(file, channels, new Map([[id, { positions: 'position', names: 'name', unit: 'native' }]]));
        assert.equal(prepared.events[0].entries.get('hinge'), 0.75);
    });
}

test('custom ROS 2 fields decode from the recording schema, with unnamed positions mapped by index', async () => {
    const definition = 'float64[] actuator_positions';
    const writer = new Ros2Writer(parse(definition, { ros2: true }));
    const file = await mcapFile([{ topic: '/arm', encoding: 'cdr', schema: { encoding: 'ros2msg', name: 'arm_msgs/msg/Arm', data: definition },
        messages: [[100n, writer.writeMessage({ actuator_positions: [0.125, 0.25] })]] }]);
    const channels = await inspectMcap(file);
    const prepared = await readMcapTopics(file, channels, new Map([[channels[0].id, { positions: 'actuator_positions', names: '', unit: 'native' }]]));
    assert.deepEqual([...prepared.events[0].entries], [['0', 0.125], ['1', 0.25]]);
});

test('the topic picker exposes positions inside a trajectory point and its joint names', async () => {
    const definition = 'string[] joint_names\ntrajectory_msgs/JointTrajectoryPoint[] points\n===\nMSG: trajectory_msgs/JointTrajectoryPoint\nfloat64[] positions';
    const writer = new Ros2Writer(parse(definition, { ros2: true }));
    const file = await mcapFile([{ topic: '/control/joint_trajectory', encoding: 'cdr',
        schema: { encoding: 'ros2msg', name: 'trajectory_msgs/msg/JointTrajectory', data: definition },
        messages: [[1n, writer.writeMessage({ joint_names: ['hinge'], points: [{ positions: [0.5] }] })]] }]);
    const channels = await inspectMcap(file);
    assert.ok(channels[0].positions.includes('points.0.positions'));
    assert.ok(channels[0].names.includes('joint_names'));
    const prepared = await readMcapTopics(file, channels, new Map([[channels[0].id,
        { positions: 'points.0.positions', names: 'joint_names', unit: 'native' }]]));
    assert.equal(prepared.events[0].entries.get('hinge'), 0.5);
});

test('invalid files, bad field rules and empty mappings give actionable errors', async () => {
    const file = await mcapFile([encoderTopic]);
    await assert.rejects(inspectMcap(file.slice(0, file.size - 5)), /Incomplete|magic/i);
    const channels = await inspectMcap(file);
    const id = channels[0].id;
    await assert.rejects(readMcapTopics(file, channels, new Map()), /Select at least one topic/);
    await assert.rejects(readMcapTopics(file, channels, new Map([[id, { ...encoderRule, positions: 'absent' }]])), /encoders.*Missing field/);
    const prepared = await readMcapTopics(file, channels, new Map([[id, encoderRule]]));
    assert.throws(() => makeMcapRecording(prepared, new Map(), model, 'arm.mcap'), /Map at least one/);
});
