/** Viewer-only state contract and recording helpers. No CAN or behavior knowledge. */
export function validateSnapshot(packet) {
    if (packet?.type !== 'state' || packet.version !== 1) throw new Error('Expected state schema version 1');
    if (typeof packet.session !== 'string' || !packet.session || !Number.isSafeInteger(packet.sequence) || packet.sequence < 0) throw new Error('Invalid session or sequence');
    if (!Number.isFinite(packet.simulation_time) || packet.simulation_time < 0) throw new Error('Invalid simulation time');
    if (!['running', 'paused', 'stopped'].includes(packet.status)) throw new Error('Unknown simulation status');
    if (!packet.joints || typeof packet.joints !== 'object' || Array.isArray(packet.joints)) throw new Error('Missing joint snapshot');
    for (const [name, joint] of Object.entries(packet.joints)) {
        if (!joint || !Number.isFinite(joint.position)) throw new Error(`${name}: invalid position`);
        if (!['rad', 'm'].includes(joint.unit)) throw new Error(`${name}: expected rad or m`);
        for (const key of ['velocity', 'effort', 'target', 'reported', 'reported_time']) {
            if (joint[key] !== undefined && !Number.isFinite(joint[key])) throw new Error(`${name}: invalid ${key}`);
        }
    }
    if (packet.base_pose) {
        const { position, quaternion } = packet.base_pose;
        if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)
            || !Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(Number.isFinite)
            || Math.abs(Math.hypot(...quaternion) - 1) > 0.01) throw new Error('Base pose requires xyz meters and normalized xyzw quaternion');
    }
    return packet;
}

export function mapSnapshot(packet, model, mapping = {}) {
    const values = {}, diagnostics = [], targets = new Set();
    if (!model?.joints) return { values, diagnostics: ['Load a robot model first'] };
    for (const [source, joint] of Object.entries(packet.joints)) {
        const target = Object.hasOwn(mapping, source) ? mapping[source] : source;
        if (target === null || target === '') continue;
        const modelJoint = model.joints.get(target);
        if (!modelJoint || modelJoint.type === 'fixed') { diagnostics.push(`${source}: unknown or fixed model joint ${target}`); continue; }
        if (targets.has(target)) throw new Error(`Duplicate mapping to ${target}`);
        targets.add(target);
        const unit = modelJoint.type === 'prismatic' ? 'm' : 'rad';
        if (joint.unit !== unit) { diagnostics.push(`${source}: ${joint.unit} is incompatible with ${modelJoint.type}`); continue; }
        values[target] = joint.position;
        if (modelJoint.type !== 'continuous' && modelJoint.limits &&
            (joint.position < modelJoint.limits.lower || joint.position > modelJoint.limits.upper)) diagnostics.push(`${target}: reported position exceeds model limits`);
    }
    for (const [name, joint] of model.joints) {
        if (joint.type !== 'fixed' && !targets.has(name) && !joint.mimicJoint) diagnostics.push(`${name}: no streamed joint mapped; retaining its last value`);
    }
    return { values, diagnostics };
}

export class LiveRecording {
    constructor(limit = 100000) {
        this.limit = limit;
        this.data = { version: 1, type: 'robot-live-recording', segments: [] };
        this.count = 0;
    }
    append(snapshot, mapping = {}, gap = false) {
        validateSnapshot(snapshot);
        if (this.count >= this.limit) throw new Error('Recording sample limit reached');
        let segment = this.data.segments.at(-1);
        if (!segment || segment.session !== snapshot.session || gap || JSON.stringify(segment.mapping) !== JSON.stringify(mapping)) {
            segment = { session: snapshot.session, robot: snapshot.robot, mapping: { ...mapping }, gapBefore: gap, samples: [] };
            this.data.segments.push(segment);
        }
        if (segment.samples.length && snapshot.simulation_time < segment.samples.at(-1).simulation_time) throw new Error('Recording time moved backwards');
        segment.samples.push(structuredClone(snapshot));
        this.count++;
    }
    static load(data) {
        if (data?.type !== 'robot-live-recording' || data.version !== 1 || !Array.isArray(data.segments)) throw new Error('Invalid live recording');
        const recording = new LiveRecording();
        for (const segment of data.segments) {
            if (!Array.isArray(segment.samples)) throw new Error('Missing segment samples');
            segment.samples.forEach((sample, index) => recording.append(sample, segment.mapping ?? {}, index === 0 && recording.count > 0));
        }
        return recording;
    }
}

/** Prepare an animation copy before changing viewer mode or modifying the editor. */
export function recordedClipData(segment, model) {
    if (!model?.joints) throw new Error('Load the robot model before creating an animation clip.');
    if (!segment?.samples?.length) throw new Error('Record motion or open a .robotlive.json recording, then select a segment.');
    const start = segment.samples[0].simulation_time;
    const durationMs = (segment.samples.at(-1).simulation_time - start) * 1000;
    if (!(durationMs > 0)) throw new Error('This segment has no elapsed simulation time. Resume the simulator and record a few seconds of motion first.');
    const tracks = new Map();
    let previousTime = -Infinity;
    for (const sample of segment.samples) {
        validateSnapshot(sample);
        if (sample.simulation_time < previousTime) throw new Error('Recording timestamps are out of order.');
        previousTime = sample.simulation_time;
        const { values } = mapSnapshot(sample, model, segment.mapping ?? {});
        for (const [joint, value] of Object.entries(values)) {
            if (!tracks.has(joint)) tracks.set(joint, new Map());
            tracks.get(joint).set((sample.simulation_time - start) * 1000, value);
        }
    }
    if (!tracks.size) throw new Error('No recorded joints match the loaded model. Load the matching model or correct the recording joint mapping.');
    return { durationMs, tracks: [...tracks].map(([jointName, points]) => ({ jointName, points: [...points] })) };
}
