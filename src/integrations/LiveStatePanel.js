import { validateSnapshot, mapSnapshot, LiveRecording, recordedClipData } from './LiveState.js';
import './live-state.css';

export class LiveStatePanel {
    constructor(app) {
        this.app = app;
        this.socket = null;
        this.latest = null;
        this.receivedAt = 0;
        this.session = null;
        this.retiredSessions = new Set();
        this.sequence = -1;
        this.mapping = {};
        this.recording = new LiveRecording();
        this.recordingActive = false;
        this.replaying = false;
        this.needsApply = false;
        this.lastStatusAt = 0;
        this.gap = false;
        this.connectionError = '';
        this.reconnectTimer = null;
        this.wantConnected = false;
        this.createPanel();
    }

    createPanel() {
        const root = document.createElement('details');
        root.className = 'live-state-panel';
        root.innerHTML = `<summary>Live simulation <span data-status>Local mode</span></summary>
          <div class="live-state-content">
          <label>State endpoint <input data-endpoint value="ws://localhost:8766/state"></label>
          <label>Expected robot (optional) <input data-robot placeholder="Robot identifier"></label>
          <div><button data-connect>Connect</button><button data-disconnect>Disconnect</button><button data-local>Return to local mode</button></div>
          <label>Joint mapping (source → model name, JSON)<textarea data-mapping>{}</textarea></label>
          <div><button data-apply>Apply mapping</button><button data-save-map>Export mapping</button><button data-load-map>Import mapping</button></div>
          <label>Inspect joint <select data-joint></select></label>
          <label><input type="checkbox" data-overlays checked> Show targets, measurements and device status</label>
          <pre data-values></pre><p data-diagnostics role="status"></p>
          <div><button data-record>Record motion</button><button data-export>Export recording</button><button data-import>Open recording</button></div>
          <p data-record-status role="status">No motion recorded.</p>
          <label>Segment <select data-segment></select></label>
          <p>To edit motion: Record motion → let the robot move → Stop recording → select a segment → Create animation clip. The Animation Editor opens; press ▶ Play there.</p>
          <div><button data-replay>Replay segment</button><button data-stop-replay>Stop replay</button><button data-animation>Create animation clip</button></div>
          <p data-animation-result role="status"></p>
          <input data-file type="file" accept=".json" hidden>
          <p>Display only. Closing this connection does not stop the simulator.</p></div>`;
        document.body.append(root);
        this.root = root;
        const get = name => root.querySelector(`[data-${name}]`);
        this.get = get;
        const stored = localStorage.getItem('robot-viewer-live-v1');
        if (stored) {
            try { const config = JSON.parse(stored); get('endpoint').value = config.endpoint; this.mapping = config.mapping ?? {}; get('mapping').value = JSON.stringify(this.mapping); get('robot').value = config.robot ?? ''; } catch { /* use defaults */ }
        }
        get('connect').onclick = () => this.connect();
        get('disconnect').onclick = () => this.disconnect();
        get('local').onclick = () => { this.disconnect(); this.lock(false); this.setStatus('Local mode'); };
        get('apply').onclick = () => this.guard(() => {
            const value = JSON.parse(get('mapping').value);
            if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => v !== null && typeof v !== 'string')) throw new Error('Mapping must be an object of joint names');
            if (this.latest) mapSnapshot(this.latest, this.app.currentModel, value);
            this.mapping = value;
            this.persist(); this.needsApply = true;
        });
        get('save-map').onclick = () => this.download('joint-mapping.json', { version: 1, robot: get('robot').value, mapping: this.mapping });
        get('load-map').onclick = () => this.openFile('mapping');
        get('record').onclick = () => {
            if (!this.recordingActive && this.socket?.readyState !== WebSocket.OPEN) {
                get('record-status').textContent = 'Connect to a simulator before recording motion.';
                return;
            }
            this.recordingActive = !this.recordingActive;
            if (this.recordingActive) this.recording = new LiveRecording();
            get('record').textContent = this.recordingActive ? 'Stop recording' : 'Record motion';
            this.updateSegments();
            this.updateRecordingStatus();
        };
        get('export').onclick = () => this.download('motion.robotlive.json', this.recording.data);
        get('import').onclick = () => this.openFile('recording');
        get('replay').onclick = () => this.guard(() => this.replay());
        get('stop-replay').onclick = () => { this.replaying = false; this.setStatus('Replay stopped — last pose retained'); };
        get('animation').onclick = () => {
            try { this.createAnimation(); }
            catch (error) { get('animation-result').textContent = error.message; }
        };
        get('segment').onchange = () => this.updateRecordingStatus();
        get('file').onchange = event => this.guardAsync(async () => {
            const file = event.target.files?.[0]; if (!file) return;
            const data = JSON.parse(await file.text());
            if (this.importKind === 'mapping') {
                if (data.version !== 1) throw new Error('Unsupported mapping version');
                get('mapping').value = JSON.stringify(data.mapping);
                get('apply').click();
            } else { this.recording = LiveRecording.load(data); this.recordingActive = false; get('record').textContent = 'Record motion'; this.updateSegments(); }
            event.target.value = '';
        });
        this.updateRecordingStatus();
    }

    guard(action) { try { action(); } catch (error) { this.get('diagnostics').textContent = error.message; } }
    async guardAsync(action) { try { await action(); } catch (error) { this.get('diagnostics').textContent = error.message; } }
    persist() { localStorage.setItem('robot-viewer-live-v1', JSON.stringify({ endpoint: this.get('endpoint').value, robot: this.get('robot').value, mapping: this.mapping })); }
    setStatus(value) { this.get('status').textContent = value; }
    download(name, value) {
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
    }
    openFile(kind) { this.importKind = kind; this.get('file').click(); }

    lock(active) {
        this.app.poseController.liveLocked = active;
        const jointPanel = document.getElementById('joint-controls-panel');
        if (jointPanel) jointPanel.inert = active;
        if (active) {
            this.app.animationWorkspace?.playback.pause();
            this.app.animationWorkspace?.stopRecording();
            this.app.mujocoSimulationManager?.pauseSimulation();
            if (this.app.sceneManager?.dragControls) this.app.sceneManager.dragControls.enabled = false;
            if (this.app.currentModel?.threeObject) this.app.currentModel.threeObject.visible = true;
        } else if (this.app.sceneManager?.dragControls) this.app.sceneManager.dragControls.enabled = true;
    }

    connect() {
        this.guard(() => {
            this.disconnect(); this.persist();
            this.wantConnected = true;
            this.connectionError = '';
            this.latest = null;
            this.receivedAt = 0;
            this.retiredSessions.clear(); this.session = null; this.sequence = -1;
            const socket = new WebSocket(this.get('endpoint').value);
            this.socket = socket;
            this.setStatus('Connecting');
            socket.onopen = () => { if (this.socket === socket) this.setStatus('Connected — waiting for state'); };
            socket.onmessage = event => {
                if (this.socket !== socket) return;
                try {
                    const packet = JSON.parse(event.data);
                    if (packet.type !== 'state') return;
                    validateSnapshot(packet);
                    const expected = this.get('robot').value.trim();
                    if (expected && packet.robot !== expected) throw new Error(`Robot mismatch: expected ${expected}, received ${packet.robot}`);
                    if (this.retiredSessions.has(packet.session)) return;
                    if (packet.session === this.session && packet.sequence <= this.sequence) return;
                    if (packet.session !== this.session) {
                        if (this.session) this.retiredSessions.add(this.session);
                        this.session = packet.session;
                    }
                    this.sequence = packet.sequence;
                    const now = performance.now();
                    const gap = this.gap || this.receivedAt && now - this.receivedAt > this.staleMs();
                    this.receivedAt = now; this.latest = packet; this.needsApply = true; this.gap = false;
                    this.lock(true);
                    if (this.recordingActive) {
                        try { this.recording.append(packet, this.mapping, Boolean(gap)); }
                        catch (error) { this.recordingActive = false; this.get('record').textContent = 'Record motion'; throw error; }
                        this.updateSegments();
                    }
                    this.connectionError = '';
                } catch (error) { this.connectionError = `Incompatible state: ${error.message}`; this.get('diagnostics').textContent = this.connectionError; }
            };
            socket.onclose = () => {
                if (this.socket !== socket) return;
                this.setStatus('Disconnected — retrying in 2 s'); this.gap = true;
                if (this.wantConnected) this.reconnectTimer = setTimeout(() => { if (this.wantConnected) this.connect(); }, 2000);
            };
            socket.onerror = () => { if (this.socket === socket) this.setStatus('Connection error'); };
        });
    }
    disconnect() {
        this.wantConnected = false;
        clearTimeout(this.reconnectTimer);
        const old = this.socket; this.socket = null; old?.close(); this.replaying = false; this.gap = true;
        this.setStatus('Disconnected — last pose retained');
    }
    staleMs() { return Math.max(500, 5000 / (this.latest?.publish_hz || 30)); }
    updateSegments() {
        const select = this.get('segment');
        const current = select.value;
        select.replaceChildren(...this.recording.data.segments.map((s, index) => {
            const option = document.createElement('option'); option.value = index;
            option.textContent = `${index + 1}: ${s.robot} · ${s.samples.length} snapshots${s.gapBefore ? ' · gap' : ''}`; return option;
        }));
        if (current) select.value = current;
        this.updateRecordingStatus();
    }

    updateRecordingStatus() {
        const count = this.recording.count;
        const segment = this.recording.data.segments[Number(this.get('segment').value)];
        const connected = this.socket?.readyState === WebSocket.OPEN;
        const stale = connected && this.receivedAt && performance.now() - this.receivedAt > this.staleMs();
        const state = this.recordingActive
            ? (!connected ? 'Recording waiting for connection' : stale ? 'Recording waiting for fresh state' : 'Recording')
            : count ? 'Recording stopped — captured in this browser' : 'No motion recorded';
        this.get('record-status').textContent = `${state}. ${count} snapshots · ${this.recording.data.segments.length} segments.${!this.recordingActive && count ? ' Export recording to save the original file.' : ''}`;
        this.get('record').disabled = !this.recordingActive && !connected;
        this.get('animation').disabled = this.recordingActive || !segment?.samples.length || !this.app.currentModel;
        this.get('animation').title = this.recordingActive ? 'Stop recording first' : !this.app.currentModel ? 'Load the robot model first' : 'Create an editable clip from the selected recorded segment';
        this.get('export').disabled = !count;
    }

    replay() {
        const segment = this.recording.data.segments[Number(this.get('segment').value)];
        if (!segment?.samples.length) throw new Error('Select a recorded segment');
        this.disconnect(); this.lock(true);
        this.replaySegment = segment; this.replayIndex = 0;
        this.replayStart = performance.now(); this.replaying = true;
        this.mapping = { ...segment.mapping };
    }

    createAnimation() {
        if (this.recordingActive) throw new Error('Stop recording before creating an animation clip.');
        const segment = this.recording.data.segments[Number(this.get('segment').value)];
        const prepared = recordedClipData(segment, this.app.currentModel);
        this.disconnect(); this.lock(false); this.needsApply = false;
        const workspace = this.app.animationWorkspace;
        const store = workspace.store;
        const created = store.mutate('Create clip from live recording', 'clipCreated', () => {
            const clip = store.createClip('Recorded simulation', prepared.tracks.map(t => t.jointName), prepared.durationMs);
            for (const track of clip.tracks) {
                const { points } = prepared.tracks.find(t => t.jointName === track.jointName);
                track.keyframes = points.map(([timeMs, value], index) => ({ id: `live-${track.id}-${index}`, timeMs, value, interpolation: 'linear', inHandle: { dxMs: 0, dy: 0 }, outHandle: { dxMs: 0, dy: 0 } }));
            }
            store.project.clips.push(clip); store.project.activeClipId = clip.id;
            return clip;
        });
        workspace.guideVisible = false;
        workspace.playback.seek(0);
        workspace.open();
        requestAnimationFrame(() => workspace.fitTime());
        const message = `Created "${created.name}": ${created.tracks.length} joints, ${(created.durationMs / 1000).toFixed(2)} s. The Animation Editor is open; press ▶ Play or edit its keyframes. The original recording is retained.`;
        this.get('animation-result').textContent = message;
        this.setStatus('Animation clip created — editor open');
        this.root.open = false;
        workspace.showToast(message);
        this.updateRecordingStatus();
    }

    update(now) {
        if (!this.lastRecordingStatusAt || now - this.lastRecordingStatusAt > 250) {
            this.lastRecordingStatusAt = now;
            this.updateRecordingStatus();
        }
        if (this.replaying) {
            const samples = this.replaySegment.samples;
            const t = samples[0].simulation_time + (now - this.replayStart) / 1000;
            while (this.replayIndex + 1 < samples.length && samples[this.replayIndex + 1].simulation_time <= t) this.replayIndex++;
            this.latest = samples[this.replayIndex]; this.needsApply = true;
            this.setStatus('Replay');
            if (t >= samples.at(-1).simulation_time) { this.replaying = false; this.setStatus('Replay complete'); }
        }
        if (this.needsApply && this.latest) {
            this.needsApply = false;
            this.guard(() => {
                const { values, diagnostics } = mapSnapshot(this.latest, this.app.currentModel, this.mapping);
                this.app.poseController.applyPose(values, { source: 'live', ignoreLimits: true, applyConstraints: false });
                const object = this.app.currentModel?.threeObject;
                if (object && this.latest.base_pose) {
                    object.position.fromArray(this.latest.base_pose.position);
                    object.quaternion.fromArray(this.latest.base_pose.quaternion);
                    object.updateMatrixWorld(true);
                }
                this.get('diagnostics').textContent = diagnostics.join('\n');
                const select = this.get('joint');
                const names = Object.keys(this.latest.joints);
                if (Array.from(select.options, o => o.value).join() !== names.join()) select.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.textContent = name; return option; }));
                this.get('values').textContent = this.get('overlays').checked ? JSON.stringify(this.latest.joints[select.value] ?? {}, null, 2) : '';
            });
        }
        if (now - this.lastStatusAt > 200 && this.socket?.readyState === 1 && this.latest) {
            this.lastStatusAt = now;
            const age = now - this.receivedAt;
            this.setStatus(this.connectionError || (age > this.staleMs() ? `Stale (${Math.round(age)} ms)` : `${this.latest.status === 'running' ? 'Live' : this.latest.status} · ${this.latest.simulation_time.toFixed(3)} s`));
        }
    }
}
