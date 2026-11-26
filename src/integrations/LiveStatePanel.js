import { validateSnapshot, mapSnapshot, LiveRecording, recordedClipData } from './LiveState.js';
import './live-state.css';

function clockTime(seconds) {
    const tenths = Math.floor(Math.max(0, seconds) * 10);
    const minutes = Math.floor(tenths / 600);
    return `${minutes}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

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
        this.importGeneration = 0;
        this.recordingName = '';
        this.liveAvailable = true;
        this.createPanel();
    }

    createPanel() {
        const root = document.createElement('details');
        root.className = 'live-state-panel';
        root.innerHTML = `<summary class="motion-heading"><span class="motion-bars" aria-hidden="true"></span>
            <strong>Motion player</strong><span data-status>Idle</span><span class="motion-chevron" aria-hidden="true"></span></summary>
          <div class="motion-tabs" role="tablist" aria-label="Motion source">
            <button role="tab" id="motion-playback-tab" aria-controls="motion-playback" aria-selected="true">Playback</button>
            <button role="tab" id="motion-live-tab" aria-controls="motion-live" aria-selected="false" tabindex="-1">Live capture</button>
          </div>
          <div class="motion-body">
            <div id="motion-playback" role="tabpanel" aria-labelledby="motion-playback-tab">
              <div data-loaded hidden>
                <div class="motion-file"><span class="motion-file-icon" aria-hidden="true"></span>
                  <div><strong data-name></strong><small data-metadata></small></div></div>
                <label data-segment-label hidden>Segment<select data-segment></select></label>
                <div class="motion-time"><span data-elapsed>0:00.0</span><span data-duration></span></div>
                <progress data-progress max="1" value="0" aria-label="Segment playback progress"></progress>
                <div class="motion-transport">
                  <button data-replay class="motion-primary">▶&nbsp; Play segment</button>
                  <button data-stop-replay class="motion-primary" hidden>■&nbsp; Stop playback</button>
                  <button data-remap hidden>Edit mapping</button>
                </div>
              </div>
              <p data-prerequisite class="motion-note" hidden>Load a robot model to play motion.</p>
              <div class="motion-files"><button data-import class="motion-primary"><span data-import-label>Open recording</span>
                  <small data-empty>MCAP or .robotlive.json</small></button>
                <details data-file-actions hidden><summary>More actions</summary>
                  <div class="motion-actions"><button data-export>Export recording</button>
                    <button data-animation>Create animation clip</button></div>
                </details></div>
            </div>
            <div id="motion-live" role="tabpanel" aria-labelledby="motion-live-tab" hidden>
              <p data-offline class="motion-note" hidden>Live connections are unavailable in the offline viewer.</p>
              <label>State endpoint<input data-endpoint value="ws://localhost:8766/state" spellcheck="false"></label>
              <div class="motion-transport"><button data-connect class="motion-primary">Connect</button>
                <button data-disconnect hidden>Disconnect</button><button data-record disabled>Record motion</button></div>
              <p data-record-status class="motion-note" role="status"></p>
              <details class="motion-disclosure"><summary>Connection &amp; joint mapping</summary>
                <label>Expected robot (optional)<input data-robot placeholder="Robot identifier"></label>
                <label>Joint mapping (source → model, JSON)<textarea data-mapping spellcheck="false">{}</textarea></label>
                <div class="motion-actions"><button data-apply>Apply mapping</button><button data-load-map>Import mapping</button>
                  <button data-save-map>Export mapping</button></div>
              </details>
            </div>
            <p data-error class="motion-error" role="alert"></p>
            <p data-animation-result role="status"></p>
            <details data-inspector class="motion-disclosure" hidden><summary>Joint inspector <span data-warning-count></span></summary>
              <label>Inspect joint<select data-joint></select></label>
              <label class="motion-check"><input type="checkbox" data-overlays checked> Show recorded values</label>
              <pre data-values></pre><p data-diagnostics></p>
            </details>
            <button data-local class="motion-local" hidden>Return to local mode</button>
          </div>
          <input data-file type="file" accept=".json,.mcap" hidden>`;
        document.body.append(root);
        this.root = root;
        const controls = new Map();
        const get = name => {
            if (!controls.has(name)) controls.set(name, root.querySelector(`[data-${name}]`));
            return controls.get(name);
        };
        this.get = get;
        const tabs = [...root.querySelectorAll('[role="tab"]')];
        this.showTab = id => {
            for (const tab of tabs) {
                const panel = tab.getAttribute('aria-controls');
                const active = panel === id;
                tab.setAttribute('aria-selected', String(active));
                tab.tabIndex = active ? 0 : -1;
                document.getElementById(panel).hidden = !active;
            }
        };
        for (const tab of tabs) {
            tab.onclick = () => this.showTab(tab.getAttribute('aria-controls'));
            tab.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const other = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(t => t !== tab);
                other.click();
                other.focus();
            };
        }
        const stored = localStorage.getItem('robot-viewer-live-v1');
        if (stored) {
            try { const config = JSON.parse(stored); get('endpoint').value = config.endpoint; this.mapping = config.mapping ?? {}; get('mapping').value = JSON.stringify(this.mapping); get('robot').value = config.robot ?? ''; } catch { /* use defaults */ }
        }
        get('connect').onclick = () => this.connect();
        get('disconnect').onclick = () => this.disconnect();
        get('local').onclick = () => {
            if (this.recordingActive) get('record').click();
            this.disconnect();
            this.lock(false);
            this.setStatus('Local mode');
        };
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
            if (this.recordingActive) {
                this.recording = new LiveRecording();
                this.recordingName = 'Live recording';
                this.replaySegment = null;
                this.mcapFile = null;
                get('remap').hidden = true;
            }
            if (!this.recordingActive && this.recording.count) this.showTab('motion-playback');
            get('record').textContent = this.recordingActive ? 'Stop recording' : 'Record motion';
            this.updateSegments();
        };
        get('export').onclick = () => this.download('motion.robotlive.json', this.recording.data);
        get('import').onclick = () => this.openFile('recording');
        get('remap').onclick = () => this.openMcap(this.mcapFile);
        get('replay').onclick = () => this.guard(() => this.replay());
        get('stop-replay').onclick = () => {
            this.replaying = false;
            this.setStatus('Playback stopped');
            this.updateRecordingStatus();
            get('replay').focus();
        };
        get('animation').onclick = () => {
            try { this.createAnimation(); }
            catch (error) { get('animation-result').textContent = error.message; }
        };
        get('segment').onchange = () => this.updateRecordingStatus();
        get('overlays').onchange = get('joint').onchange = () => this.showJointValues();
        get('file').onchange = event => this.guardAsync(async () => {
            const file = event.target.files?.[0]; if (!file) return;
            const kind = this.importKind;
            event.target.value = '';
            if (kind === 'recording' && /\.mcap$/i.test(file.name)) return this.openMcap(file);
            const generation = ++this.importGeneration;
            const data = JSON.parse(await file.text());
            if (generation !== this.importGeneration) return;
            if (kind === 'mapping') {
                if (data.version !== 1) throw new Error('Unsupported mapping version');
                get('mapping').value = JSON.stringify(data.mapping);
                get('apply').click();
            } else { this.useRecording(LiveRecording.load(data), file); }
        });
        this.app.poseController.subscribe(event => {
            if (event.type === 'modelChanged') this.updateRecordingStatus();
        });
        this.updateRecordingStatus();
    }

    guard(action) { try { action(); } catch (error) { this.get('error').textContent = error.message; } }
    async guardAsync(action) { try { await action(); } catch (error) { this.get('error').textContent = error.message; } }
    persist() { localStorage.setItem('robot-viewer-live-v1', JSON.stringify({ endpoint: this.get('endpoint').value, robot: this.get('robot').value, mapping: this.mapping })); }
    setStatus(value) {
        if (this.get('status').textContent !== value) this.get('status').textContent = value;
        this.get('status').title = value;
    }
    showJointValues() {
        const name = this.get('joint').value;
        this.get('values').textContent = this.get('overlays').checked && this.latest?.joints[name]
            ? JSON.stringify(this.latest.joints[name], null, 2) : '';
    }
    download(name, value) {
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
    }
    openFile(kind) {
        this.get('error').textContent = '';
        this.importKind = kind;
        this.get('file').accept = kind === 'recording' ? '.json,.mcap' : '.json';
        this.get('file').click();
    }

    useRecording(recording, file = null) {
        if (this.replaySegment && !this.socket) {
            this.replaying = false;
            this.needsApply = false;
            this.latest = null;
            this.lock(false);
        }
        this.recording = recording;
        this.recordingActive = false;
        this.replaySegment = null;
        this.recordingName = file?.name || 'Live recording';
        this.mcapFile = file && /\.mcap$/i.test(file.name) ? file : null;
        this.get('remap').hidden = !this.mcapFile;
        this.showTab('motion-playback');
        this.get('animation-result').textContent = '';
        this.get('error').textContent = '';
        this.get('record').textContent = 'Record motion';
        this.get('segment').value = '';
        this.updateSegments();
        if (!this.wantConnected) this.setStatus('Recording ready');
    }

    async openMcap(file) {
        const generation = ++this.importGeneration;
        this.mcapDialog?.close();
        this.root.open = true;
        this.showTab('motion-playback');
        this.get('error').textContent = '';
        const model = this.app.currentModel;
        if (!model?.joints?.size) {
            this.get('error').textContent = 'Load a URDF with movable joints, then open the MCAP recording.';
            return;
        }
        try {
            const { McapMappingDialog } = await import('./McapMappingDialog.js');
            if (generation !== this.importGeneration) return;
            const dialog = new McapMappingDialog(file, model, recording => {
                if (model !== this.app.currentModel) throw new Error('The model changed. Reopen the recording for the current model.');
                this.useRecording(recording, file);
            }, this.app.fileHandler.currentModelFile?.name);
            this.mcapDialog = dialog;
            dialog.dialog.addEventListener('close', () => {
                if (this.mcapDialog === dialog) this.mcapDialog = null;
            }, { once: true });
            await dialog.open();
        } catch (error) {
            if (generation === this.importGeneration) this.get('error').textContent = error.message;
        }
    }

    lock(active) {
        this.get('local').hidden = !active;
        this.app.poseController.liveLocked = active;
        this.app.comparisonPoseControls?.refresh();
        const jointPanel = document.getElementById('joint-controls-panel');
        if (jointPanel) jointPanel.inert = active;
        if (active) {
            this.app.animationWorkspace?.playback.pause();
            this.app.animationWorkspace?.stopRecording();
            this.app.mujocoSimulationManager?.pauseSimulation();
            if (this.app.sceneManager?.dragControls) this.app.sceneManager.dragControls.enabled = false;
            if (this.app.currentModel?.threeObject) this.app.currentModel.threeObject.visible = true;
        } else if (this.app.sceneManager?.dragControls) this.app.sceneManager.dragControls.enabled = true;
        this.app.endMoveControls?.syncLock();
    }

    connect() {
        this.guard(() => {
            if (!this.liveAvailable) return;
            this.disconnect(); this.persist();
            this.connectionError = '';
            this.latest = null;
            this.replaySegment = null;
            this.receivedAt = 0;
            this.retiredSessions.clear(); this.session = null; this.sequence = -1;
            const socket = new WebSocket(this.get('endpoint').value);
            this.wantConnected = true;
            this.socket = socket;
            this.setStatus('Connecting');
            this.updateRecordingStatus();
            socket.onopen = () => {
                if (this.socket !== socket) return;
                this.setStatus('Connected');
                this.updateRecordingStatus();
            };
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
                    }
                    this.connectionError = '';
                } catch (error) {
                    this.connectionError = `Incompatible state: ${error.message}`;
                    this.get('diagnostics').textContent = this.connectionError;
                    this.get('inspector').hidden = false;
                    this.setStatus('Stream error');
                }
            };
            socket.onclose = () => {
                if (this.socket !== socket) return;
                this.setStatus('Reconnecting'); this.gap = true;
                this.updateRecordingStatus();
                if (this.wantConnected) this.reconnectTimer = setTimeout(() => { if (this.wantConnected) this.connect(); }, 2000);
            };
            socket.onerror = () => { if (this.socket === socket) this.setStatus('Connection error'); };
        });
    }
    disconnect() {
        this.wantConnected = false;
        clearTimeout(this.reconnectTimer);
        const old = this.socket; this.socket = null; old?.close(); this.replaying = false; this.gap = true;
        this.setStatus('Disconnected');
        this.updateRecordingStatus();
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
        const samples = segment?.samples ?? [];
        const loaded = count > 0;
        const duration = samples.length ? samples.at(-1).simulation_time - samples[0].simulation_time : 0;
        const elapsed = segment && this.replaySegment === segment ? this.replayElapsed : 0;
        const get = this.get;
        get('empty').hidden = loaded;
        get('loaded').hidden = !loaded;
        get('prerequisite').hidden = !this.recordingActive && Boolean(this.app.currentModel);
        get('prerequisite').textContent = this.recordingActive
            ? 'Stop recording in Live capture to play or open a file.' : 'Load a robot model to play motion.';
        get('name').textContent = this.recordingName;
        get('name').title = this.recordingName;
        const modelName = this.app.fileHandler.currentModelFile?.name || segment?.robot;
        get('metadata').textContent = [`${samples.length.toLocaleString()} samples`, modelName].filter(Boolean).join(' · ');
        get('segment-label').hidden = this.recording.data.segments.length < 2;
        get('segment').disabled = this.replaying || this.recordingActive;
        get('elapsed').textContent = clockTime(elapsed);
        get('duration').textContent = clockTime(duration);
        get('progress').value = duration > 0 ? Math.min(1, elapsed / duration) : 0;
        get('replay').hidden = this.replaying;
        get('stop-replay').hidden = !this.replaying;
        get('replay').disabled = !samples.length || !this.app.currentModel || this.recordingActive;
        get('file-actions').hidden = !loaded;
        get('animation').disabled = get('replay').disabled || duration <= 0;
        get('import').disabled = this.recordingActive;
        get('import').classList.toggle('motion-primary', !loaded);
        get('import-label').textContent = loaded ? 'Open another file' : 'Open recording';
        get('record').disabled = !this.liveAvailable || (!connected && !this.recordingActive);
        get('connect').hidden = this.wantConnected;
        get('disconnect').hidden = !this.wantConnected;
        get('record-status').textContent = this.recordingActive
            ? `${!connected || stale ? 'Waiting for live data' : 'Recording'} · ${count.toLocaleString()} samples` : '';
        get('inspector').hidden = !this.latest && !this.connectionError;
    }

    replay() {
        const segment = this.recording.data.segments[Number(this.get('segment').value)];
        if (!segment?.samples.length) throw new Error('Select a recorded segment');
        this.get('error').textContent = '';
        this.disconnect(); this.lock(true);
        this.replaySegment = segment; this.replayIndex = 0;
        this.replayStart = performance.now(); this.replaying = true;
        this.replayElapsed = 0;
        this.setStatus('Playing');
        this.updateRecordingStatus();
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
        if ((this.recordingActive || this.replaying) && (!this.lastRecordingStatusAt || now - this.lastRecordingStatusAt > 200)) {
            this.lastRecordingStatusAt = now;
            if (this.recordingActive) this.updateSegments();
            else this.updateRecordingStatus();
        }
        if (this.replaying) {
            const samples = this.replaySegment.samples;
            const t = samples[0].simulation_time + (now - this.replayStart) / 1000;
            while (this.replayIndex + 1 < samples.length && samples[this.replayIndex + 1].simulation_time <= t) this.replayIndex++;
            this.latest = samples[this.replayIndex]; this.needsApply = true;
            this.replayElapsed = Math.min(t, samples.at(-1).simulation_time) - samples[0].simulation_time;
            if (t >= samples.at(-1).simulation_time) { this.replaying = false; this.setStatus('Replay complete'); this.updateRecordingStatus(); }
        }
        if (this.needsApply && this.latest) {
            this.needsApply = false;
            this.guard(() => {
                const mapping = this.replaySegment?.mapping ?? this.mapping;
                const { values, diagnostics } = mapSnapshot(this.latest, this.app.currentModel, mapping);
                this.app.poseController.applyPose(values, { source: 'live', ignoreLimits: true, applyConstraints: false });
                const object = this.app.currentModel?.threeObject;
                if (object && this.latest.base_pose) {
                    object.position.fromArray(this.latest.base_pose.position);
                    object.quaternion.fromArray(this.latest.base_pose.quaternion);
                    object.updateMatrixWorld(true);
                }
                this.get('diagnostics').textContent = diagnostics.join('\n');
                this.get('inspector').hidden = false;
                this.get('warning-count').textContent = diagnostics.length ? String(diagnostics.length) : '';
                const select = this.get('joint');
                const names = Object.keys(this.latest.joints);
                if (Array.from(select.options, o => o.value).join() !== names.join()) select.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.textContent = name; return option; }));
                this.showJointValues();
            });
        }
        if (now - this.lastStatusAt > 200 && this.socket?.readyState === 1 && this.latest) {
            this.lastStatusAt = now;
            const age = now - this.receivedAt;
            this.setStatus(this.connectionError || (age > this.staleMs() ? `Stale (${Math.round(age)} ms)` : `${this.latest.status === 'running' ? 'Live' : this.latest.status} · ${this.latest.simulation_time.toFixed(3)} s`));
        }
    }
}
