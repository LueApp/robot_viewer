import { inspectMcap, isPositionJoint, makeMcapRecording, readMcapTopics } from './McapRecording.js';
import './mcap-mapping.css';

function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
}

function label(text, control) {
    const node = element('label', text);
    node.append(control);
    return node;
}

function fieldInput(title, value, choices, id) {
    const input = element('input');
    input.value = value;
    const list = element('datalist');
    list.id = id;
    list.replaceChildren(...choices.map(choice => new Option(choice, choice)));
    input.setAttribute('list', id);
    const wrapper = label(title, input);
    wrapper.append(list);
    return { input, wrapper };
}

export class McapMappingDialog {
    constructor(file, model, onImport, modelFileName) {
        this.file = file;
        this.model = model;
        this.onImport = onImport;
        this.controller = new AbortController();
        this.settingsKey = 'robot-viewer-mcap-rules-v1/' + model.name;
        try { this.saved = JSON.parse(localStorage.getItem(this.settingsKey)) || {}; }
        catch { this.saved = {}; }

        const dialog = element('dialog');
        dialog.className = 'mcap-mapping';
        dialog.setAttribute('aria-labelledby', 'mcap-title');
        dialog.innerHTML = `<header><h2 id="mcap-title">Import MCAP</h2>
              <div class="mcap-context"><span data-file-name></span><span data-model-name></span></div></header>
            <ol class="mcap-steps" aria-label="Import steps"><li data-topics-step>Topic data</li><li data-joints-step>Joint mapping</li></ol>
            <div class="mcap-body"><h3 data-stage tabindex="-1"></h3><p data-help></p>
              <div class="mcap-review" hidden data-review><strong data-match-count></strong>
                <label><input type="checkbox" data-unmapped> Unmapped only</label></div>
              <div data-fields></div><p data-filter-empty hidden>All recorded joints are mapped.</p></div>
            <p class="mcap-feedback" data-feedback role="status"></p>
            <footer><button type="button" data-cancel>Cancel</button><button type="button" data-back hidden>Back</button>
            <button type="button" data-next class="motion-primary"></button></footer>`;
        this.dialog = dialog;
        this.get = key => dialog.querySelector(`[data-${key}]`);
        this.get('file-name').textContent = file.name;
        this.get('model-name').textContent = modelFileName || model.name || 'Loaded model';
        this.get('cancel').onclick = () => this.close();
        dialog.oncancel = event => { event.preventDefault(); this.close(); };
        this.get('back').onclick = () => { this.readTargets(); this.showTopics(); };
        this.get('next').onclick = () => this.advance();
        this.get('unmapped').onchange = () => this.updateJointReview();
    }

    async open() {
        document.body.append(this.dialog);
        this.dialog.showModal();
        this.get('stage').textContent = 'Reading topics…';
        this.get('next').textContent = 'Map joints';
        this.get('next').disabled = true;
        try {
            if (![...this.model.joints.values()].some(isPositionJoint)) throw new Error('Load a URDF with a revolute, continuous, or prismatic joint, then reopen this recording.');
            this.channels = await inspectMcap(this.file, this.controller.signal);
            if (!this.dialog.open) return;
            this.rules = new Map();
            this.targets = new Map();
            const counts = new Map();
            for (const channel of this.channels) counts.set(channel.topic, (counts.get(channel.topic) || 0) + 1);
            for (const channel of this.channels) {
                channel.key = JSON.stringify([channel.topic, channel.encoding, channel.schema, counts.get(channel.topic) > 1 ? channel.id : null]);
                const saved = this.saved[channel.key];
                const positions = channel.positions.includes('position') ? 'position' : '';
                const names = ['name', 'joint_names'].find(field => channel.names.includes(field)) ?? '';
                this.rules.set(channel.id, { enabled: saved?.enabled ?? Boolean(positions),
                    positions: saved?.positions ?? positions, names: saved?.names ?? names,
                    unit: saved?.unit ?? 'native' });
                this.targets.set(channel.id, new Map(Object.entries(saved?.targets ?? {})));
            }
            this.showTopics();
        } catch (error) {
            if (this.dialog.open) {
                this.get('stage').textContent = 'Cannot open recording';
                this.get('feedback').textContent = error.message;
            }
        }
    }

    close() {
        this.controller.abort();
        this.dialog.close();
        this.dialog.remove();
    }

    stage(help, next, jointStep) {
        this.jointStep = jointStep;
        this.get('stage').hidden = true;
        this.get('help').textContent = help;
        this.get('fields').replaceChildren();
        this.get('feedback').textContent = '';
        this.get('back').hidden = !jointStep;
        this.get('next').textContent = next;
        this.get('next').disabled = false;
        this.get('review').hidden = !jointStep;
        this.get('filter-empty').hidden = true;
        this.get('unmapped').checked = false;
        this.get('topics-step').setAttribute('aria-current', jointStep ? 'false' : 'step');
        this.get('joints-step').setAttribute('aria-current', jointStep ? 'step' : 'false');
        this.dialog.querySelector('.mcap-body').scrollTop = 0;
        const current = this.get(jointStep ? 'joints-step' : 'topics-step');
        current.tabIndex = -1;
        current.focus();
    }

    showTopics() {
        this.stage('Select one source per joint. Topics for different joints can play together.', 'Map joints', false);
        this.topicInputs = new Map();
        for (const channel of this.channels) {
            const rule = this.rules.get(channel.id);
            const card = element('section');
            const check = element('input');
            check.type = 'checkbox';
            check.disabled = Boolean(channel.error) || !channel.count;
            check.checked = !check.disabled && rule.enabled;
            const topic = element('label');
            topic.className = 'mcap-topic';
            topic.append(check, document.createTextNode(channel.topic));
            const meta = element('small', [channel.schema, channel.encoding, `${channel.count.toLocaleString()} messages`].filter(Boolean).join(' · '));
            meta.title = `Channel ${channel.id}`;
            card.append(topic, meta);
            this.get('fields').append(card);
            if (check.disabled) {
                card.append(element('p', channel.error || 'No messages'));
                continue;
            }

            const positions = fieldInput('Position field', rule.positions, channel.positions, `mcap-positions-${channel.id}`);
            const names = fieldInput('Joint names field (optional)', rule.names, channel.names, `mcap-names-${channel.id}`);
            const unit = element('select');
            for (const [key, text] of [['native','URDF units (rad / m)'],['rad','Radians'],['deg','Degrees'],['m','Meters'],['mm','Millimeters']]) unit.add(new Option(text, key));
            unit.value = rule.unit;
            const fields = element('details');
            const inputs = element('div');
            inputs.className = 'mcap-topic-fields';
            inputs.append(positions.wrapper, names.wrapper, label('Recorded units', unit));
            const summary = element('summary', 'Field mapping');
            const path = element('span', rule.positions);
            summary.append(path);
            positions.input.oninput = () => { path.textContent = positions.input.value; };
            positions.input.placeholder = 'Select or type a field path';
            names.input.placeholder = 'Use array indices';
            fields.append(summary, inputs);
            fields.open = !rule.positions;
            fields.hidden = !check.checked;
            check.onchange = () => {
                fields.hidden = !check.checked;
                this.get('next').disabled = ![...this.topicInputs.values()].some(input => input.check.checked);
                this.get('feedback').textContent = '';
            };
            card.append(fields);
            this.topicInputs.set(channel.id, { check, positions: positions.input, names: names.input, unit });
        }
        this.get('next').disabled = ![...this.topicInputs.values()].some(input => input.check.checked);
        if (!this.topicInputs.size) {
            this.get('next').disabled = true;
            this.get('feedback').textContent = 'No readable topics with messages in this recording.';
        }
    }

    showJoints() {
        this.stage('Each model joint takes one source. Leave a joint on Ignore to omit it from playback.', 'Import recording', true);
        this.jointInputs = new Map();
        const joints = [...this.model.joints].filter(([, joint]) => isPositionJoint(joint)).map(([name]) => name);
        for (const [id, source] of this.prepared.selected) {
            const card = element('section');
            card.className = 'mcap-joint-group';
            card.append(element('h4', source.channel.topic));
            const columns = element('div');
            columns.className = 'mcap-columns';
            columns.append(element('span', 'Recorded joint'), element('span', 'Model joint'));
            card.append(columns);
            const inputs = new Map();
            for (const name of source.names) {
                const select = element('select');
                select.add(new Option('Ignore', ''));
                for (const joint of joints) select.add(new Option(joint, joint));
                const targets = this.targets.get(id);
                const target = targets.has(name) ? targets.get(name) : name;
                select.value = joints.includes(target) ? target : '';
                const row = label(name, select);
                row.className = 'mcap-joint';
                select.onchange = () => this.updateJointReview();
                card.append(row);
                inputs.set(name, select);
            }
            this.jointInputs.set(id, inputs);
            this.get('fields').append(card);
        }
        this.updateJointReview();
    }

    updateJointReview() {
        const selects = [...this.jointInputs.values()].flatMap(inputs => [...inputs.values()]);
        const used = new Set(), duplicates = new Set();
        const mapped = selects.filter(select => select.value);
        for (const { value } of mapped) {
            if (used.has(value)) duplicates.add(value);
            used.add(value);
        }
        const filter = this.get('unmapped').checked;
        for (const select of selects) {
            select.closest('label').hidden = filter && Boolean(select.value);
            select.setAttribute('aria-invalid', String(duplicates.has(select.value)));
        }
        for (const group of this.get('fields').children) group.hidden = !group.querySelector('.mcap-joint:not([hidden])');
        this.get('match-count').textContent = `${mapped.length} of ${selects.length} mapped`;
        this.get('filter-empty').hidden = !filter || mapped.length !== selects.length;
        this.get('feedback').textContent = duplicates.size ? `Multiple sources map to ${[...duplicates].join(', ')}. Choose one per model joint.`
            : !mapped.length ? 'Map at least one recorded joint to a model joint.' : '';
        this.get('next').disabled = !mapped.length || duplicates.size > 0;
    }

    readTargets() {
        for (const [id, inputs] of this.jointInputs) {
            for (const [name, input] of inputs) this.targets.get(id).set(name, input.value);
        }
    }

    async advance() {
        const next = this.get('next');
        next.disabled = true;
        try {
            if (!this.jointStep) {
                const selected = new Map();
                for (const [id, input] of this.topicInputs) {
                    const rule = { enabled: input.check.checked, positions: input.positions.value.trim(),
                        names: input.names.value.trim(), unit: input.unit.value };
                    this.rules.set(id, rule);
                    if (rule.enabled) selected.set(id, rule);
                }
                this.get('feedback').textContent = 'Reading selected joint data…';
                this.get('fields').inert = true;
                this.prepared = await readMcapTopics(this.file, this.channels, selected, this.controller.signal);
                if (this.dialog.open) this.showJoints();
            } else {
                this.readTargets();
                const recording = makeMcapRecording(this.prepared, this.targets, this.model, this.file.name);
                this.onImport(recording);
                const rules = Object.fromEntries(this.channels.filter(channel => this.topicInputs.has(channel.id)).map(({ id, key }) => [key,
                    { ...this.rules.get(id), targets: Object.fromEntries(this.targets.get(id)) }]));
                try { localStorage.setItem(this.settingsKey, JSON.stringify({ ...this.saved, ...rules })); }
                catch { /* Storage is optional. */ }
                this.close();
            }
        } catch (error) {
            if (this.dialog.open) {
                this.get('feedback').textContent = error.message;
                next.disabled = false;
            }
        } finally {
            this.get('fields').inert = false;
            if (this.dialog.open && !this.jointStep) next.disabled = false;
        }
    }
}
