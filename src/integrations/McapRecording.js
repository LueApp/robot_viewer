import { McapStreamReader } from '@mcap/core';
import { parse } from '@foxglove/rosmsg';
import { MessageReader as Ros1Reader } from '@foxglove/rosmsg-serialization';
import { MessageReader as Ros2Reader } from '@foxglove/rosmsg2-serialization';
import { decompress as unzstd } from 'fzstd';
import { decompress as unlz4 } from 'lz4-lite';
import { LiveRecording } from './LiveState.js';

const utf8 = new TextDecoder();
const jointState = /^sensor_msgs\/(?:msg\/)?JointState$/;
const jointStateFields = 'std_msgs/Header header\nstring[] name\nfloat64[] position\nfloat64[] velocity\nfloat64[] effort';
const header = '\n===\nMSG: std_msgs/Header\n';
const units = { native: 1, rad: 1, deg: Math.PI / 180, m: 1, mm: 0.001 };
export const isPositionJoint = joint => ['continuous', 'revolute', 'prismatic'].includes(joint.type);

function messageDecoder(channel, schema) {
    if (channel.messageEncoding === 'json') return data => JSON.parse(utf8.decode(data));
    const ros2 = channel.messageEncoding === 'cdr';
    const standard = jointState.test(schema?.name);
    let definition;
    if (standard && (ros2 || channel.messageEncoding === 'ros1')) {
        // Some ROS bags identify JointState but omit the embedded definition.
        definition = jointStateFields + header + (ros2 ? '' : 'uint32 seq\n') + 'time stamp\nstring frame_id';
    } else if (ros2 && schema?.encoding === 'ros2msg' && schema.data.length) {
        definition = utf8.decode(schema.data);
    } else {
        throw new Error(`Unsupported encoding or schema (${channel.messageEncoding}, ${schema?.name || 'no schema'})`);
    }
    const definitions = parse(definition, { ros2 });
    const reader = ros2 ? new Ros2Reader(definitions) : new Ros1Reader(definitions);
    return data => reader.readMessage(data);
}

async function scan(file, visit, signal) {
    const reader = new McapStreamReader({ decompressHandlers: {
        __proto__: null,
        zstd: data => unzstd(data),
        lz4: (data, size) => unlz4(data, Number(size)),
    } });
    const block = 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += block) {
        signal?.throwIfAborted();
        reader.append(new Uint8Array(await file.slice(offset, offset + block).arrayBuffer()));
        for (let record; (record = reader.nextRecord());) visit(record);
    }
    signal?.throwIfAborted();
    if (!reader.done() || reader.bytesRemaining()) throw new Error('Incomplete MCAP or unexpected trailing bytes.');
}

const isList = value => Array.isArray(value) || ArrayBuffer.isView(value);

function fieldChoices(message) {
    const names = [], positions = [];
    function walk(value, path, depth) {
        if (typeof value === 'number') positions.push(path);
        else if (typeof value === 'string') names.push(path);
        else if (isList(value)) {
            if (!value.length || typeof value[0] === 'number') positions.push(path);
            if (!value.length || typeof value[0] === 'string') names.push(path);
            // Show an editable index for structured arrays such as JointTrajectory.points.
            if (value[0] && typeof value[0] === 'object' && depth < 8) {
                walk(value[0], path ? `${path}.0` : '0', depth + 1);
            }
        } else if (value && typeof value === 'object' && depth < 8) {
            for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key, depth + 1);
        }
    }
    walk(message, '', 0);
    return { names, positions };
}

// First pass retains only topic metadata and field choices from a sample.
// During the second pass only selected channels are deserialized.
export async function inspectMcap(file, signal) {
    const schemas = new Map(), channels = new Map();
    await scan(file, record => {
        if (record.type === 'Schema' && !schemas.has(record.id)) schemas.set(record.id, record);
        if (record.type === 'Channel' && !channels.has(record.id)) {
            const schema = schemas.get(record.schemaId);
            const channel = { id: record.id, topic: record.topic, encoding: record.messageEncoding,
                schema: schema?.name ?? '', count: 0, names: [], positions: [] };
            channels.set(channel.id, channel);
            try { channel.decode = messageDecoder(record, schema); }
            catch (error) { channel.error = error.message; }
        }
        if (record.type !== 'Message') return;
        const channel = channels.get(record.channelId);
        if (++channel.count !== 1 || channel.error) return;
        try { Object.assign(channel, fieldChoices(channel.decode(record.data))); }
        catch (error) { channel.error = `Cannot read first message · ${error.message}`; }
    }, signal);
    return [...channels.values()];
}

function field(message, path) {
    let value = message;
    for (const key of path.split('.')) {
        if (value == null || !Object.hasOwn(value, key)) throw new Error(`Missing field "${path}"`);
        value = value[key];
    }
    return value;
}

function jointEntries(message, rule) {
    const raw = field(message, rule.positions);
    const positions = isList(raw) ? raw : [raw];
    const entries = new Map();
    // JointState permits an empty position array on velocity-only updates.
    if (!positions.length) return entries;
    const labels = rule.names ? field(message, rule.names) : null;
    const names = isList(labels) ? labels : [labels];
    if (rule.names && names.length !== positions.length) throw new Error('Joint name and position counts differ');
    for (let index = 0; index < positions.length; index++) {
        const name = rule.names ? names[index] : isList(raw) ? String(index) : rule.positions;
        if (typeof name !== 'string' || !name) throw new Error('Expected a joint name for each position');
        if (entries.has(name)) throw new Error(`Duplicate recorded joint "${name}"`);
        if (!Number.isFinite(positions[index])) throw new Error(`Expected a finite position for "${name}"`);
        entries.set(name, positions[index]);
    }
    return entries;
}

export async function readMcapTopics(file, channels, rules, signal) {
    const selected = new Map();
    for (const [id, rule] of rules) {
        const channel = channels.find(item => item.id === id);
        if (!channel?.decode || channel.error) throw new Error('Select a readable topic.');
        if (!rule.positions.trim()) throw new Error(`${channel.topic} needs a position field.`);
        if (!Object.hasOwn(units, rule.unit)) throw new Error(`${channel.topic} has an unknown position unit.`);
        selected.set(id, { channel, rule, names: new Set() });
    }
    if (!selected.size) throw new Error('Select at least one topic.');
    const events = [];
    const limit = new LiveRecording().limit;
    await scan(file, record => {
        if (record.type !== 'Message') return;
        const source = selected.get(record.channelId);
        if (!source) return;
        try {
            const entries = jointEntries(source.channel.decode(record.data), source.rule);
            if (!entries.size) return;
            if (events.length >= limit) throw new Error(`Select fewer topics or a shorter recording (limit ${limit} messages)`);
            for (const name of entries.keys()) source.names.add(name);
            events.push({ id: record.channelId, time: record.logTime, entries });
        } catch (error) { throw new Error(`${source.channel.topic} at ${record.logTime} ns · ${error.message}`); }
    }, signal);
    for (const source of selected.values()) {
        if (!source.names.size) throw new Error(`${source.channel.topic} has no joint positions in the selected field.`);
    }
    events.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
    return { selected, events };
}

export function makeMcapRecording({ selected, events }, targets, model, filename) {
    const used = new Set(), bindings = new Map();
    for (const [id, source] of selected) {
        const mapped = new Map();
        for (const name of source.names) {
            const target = targets.get(id)?.get(name);
            if (!target) continue;
            const joint = model?.joints.get(target);
            if (!joint || !isPositionJoint(joint)) throw new Error(`Unknown or immovable target "${target}".`);
            if (used.has(target)) throw new Error(`Multiple sources map to "${target}". Choose one source per URDF joint.`);
            const unit = joint.type === 'prismatic' ? 'm' : 'rad';
            const inputUnit = source.rule.unit;
            if (inputUnit !== 'native' && (unit === 'm') !== ['m', 'mm'].includes(inputUnit)) {
                throw new Error(`${source.channel.topic} uses ${inputUnit}, incompatible with "${target}" (${unit}).`);
            }
            used.add(target);
            mapped.set(name, { target, unit, factor: units[inputUnit] });
        }
        bindings.set(id, mapped);
    }
    if (!used.size) throw new Error('Map at least one recorded joint to a URDF joint.');
    const recording = new LiveRecording();
    const joints = Object.create(null);
    let start;
    // Coalesce simultaneous topics and carry state forward between updates.
    for (let i = 0; i < events.length;) {
        const time = events[i].time;
        let changed = false;
        do {
            const event = events[i++];
            for (const [name, position] of event.entries) {
                const binding = bindings.get(event.id).get(name);
                if (!binding) continue;
                joints[binding.target] = { position: position * binding.factor, unit: binding.unit };
                changed = true;
            }
        } while (events[i]?.time === time);
        if (!changed) continue;
        start ??= time;
        recording.append({ type: 'state', version: 1, session: filename, robot: model.name || filename,
            sequence: recording.count, simulation_time: Number(time - start) / 1e9, status: 'running', joints });
    }
    return recording;
}
