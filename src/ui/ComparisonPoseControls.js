import { canLinkJoints, isPoseJoint } from '../renderer/URDFOverlay.js';

export class ComparisonPoseControls {
    constructor(scene, primaryPose, units) {
        this.scene = scene;
        this.primaryPose = primaryPose;
        this.units = units;
        this.panel = document.getElementById('floating-joints-panel');
        this.tabs = document.getElementById('comparison-joint-tabs');
        this.table = document.getElementById('comparison-poses');
        this.cells = [];
        this.page = 'compare';
        this.link = this.table.querySelector('[data-link-poses]');
        this.link.onchange = () => {
            scene.comparisonLinked = this.link.checked;
            scene.alignLinkedJoints();
            this.refresh();
            scene.redraw();
        };
        for (const button of this.tabs.querySelectorAll('button')) {
            button.onclick = () => {
                this.page = button.dataset.posePage;
                this.showPage();
            };
        }
        scene.on('comparisonChanged', () => this.build());
        const queueRefresh = () => {
            if (!this.cells.length || this.table.hidden || this.frame) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                this.refresh(null, false);
            });
        };
        scene.on('referencePoseChanged', queueRefresh);
        primaryPose.subscribe(event => {
            if (event.type === 'jointChanged') queueRefresh();
        });
    }

    showPage() {
        const comparing = Boolean(this.scene.comparisonOverlay);
        const tableVisible = comparing && this.page === 'compare';
        this.tabs.hidden = !comparing;
        this.table.hidden = !tableVisible;
        this.panel.classList.toggle('comparing-poses', tableVisible);
        for (const button of this.tabs.querySelectorAll('button')) {
            button.setAttribute('aria-pressed', String(button.dataset.posePage === this.page));
        }
        if (tableVisible) this.refresh();
    }

    build() {
        const overlay = this.scene.comparisonOverlay;
        const rows = this.table.querySelector('[data-pose-rows]');
        rows.replaceChildren();
        this.cells = [];
        if (overlay) {
            const primary = this.scene.currentModel.joints;
            const reference = overlay.model.joints;
            const names = new Set([...primary.keys(), ...reference.keys()]);
            for (const name of names) {
                if (!isPoseJoint(primary.get(name)) && !isPoseJoint(reference.get(name))) continue;
                const row = document.createElement('div');
                row.className = 'comparison-joint';
                const label = document.createElement('strong');
                label.textContent = name;
                row.append(label, this.makeCell('primary', primary.get(name)), this.makeCell('reference', reference.get(name)));
                rows.append(row);
            }
            if (!this.cells.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.dataset.i18n = 'noControllableJoints';
                empty.textContent = window.i18n.t(empty.dataset.i18n);
                rows.append(empty);
            }
        } else {
            this.page = 'compare';
        }
        this.link.checked = this.scene.comparisonLinked;
        this.showPage();
    }

    makeCell(side, joint) {
        const cell = document.createElement('div');
        cell.className = 'comparison-joint-cell ' + side;
        if (!isPoseJoint(joint)) {
            cell.textContent = '—';
            return cell;
        }
        const range = document.createElement('input');
        range.type = 'range';
        const number = document.createElement('input');
        number.type = 'number';
        range.step = number.step = 'any';
        for (const input of [range, number]) {
            input.dataset.poseSide = side;
            input.dataset.poseJoint = joint.name;
        }
        const unit = document.createElement('span');
        const commit = (value, done) => {
            if (Number.isFinite(value)) {
                if (side === 'primary') {
                    this.primaryPose.setJointValue(joint.name, value, { source: 'user', commit: done });
                } else {
                    this.scene.setReferenceJoint(joint.name, value, done);
                }
            }
            this.refresh(done ? number : null, false);
        };
        range.oninput = () => commit(range.valueAsNumber, false);
        range.onchange = () => commit(range.valueAsNumber, true);
        number.onchange = () => commit(this.units.fromDisplayValue(joint, number.valueAsNumber), true);
        number.onblur = () => this.refresh(number, false);
        cell.append(range, number, unit);
        this.cells.push({ side, joint, range, number, unit });
        return cell;
    }

    refresh(committedInput = null, force = true) {
        for (const cell of this.cells) {
            const { side, joint, range, number, unit } = cell;
            const value = joint.threeObject.angle;
            if (!force && cell.lastValue === value && number !== committedInput) continue;
            cell.lastValue = value;
            const linked = this.link.checked && canLinkJoints(this.scene.currentModel.joints.get(joint.name), joint);
            const locked = this.primaryPose.liveLocked && (side === 'primary' || linked);
            range.disabled = number.disabled = locked || Boolean(joint.threeObject.mimicJoint);
            const continuous = joint.type === 'continuous';
            const lower = !continuous && Number.isFinite(joint.limits?.lower) ? joint.limits.lower : -Math.PI;
            const upper = !continuous && Number.isFinite(joint.limits?.upper) ? joint.limits.upper : Math.PI;
            range.min = Math.min(value, lower);
            range.max = Math.max(value, upper);
            range.value = value;
            const text = this.units.toDisplayValue(joint, value).toFixed(this.units.getDisplayDecimals(joint));
            if (number === committedInput || number !== document.activeElement) number.value = text;
            unit.textContent = this.units.getJointUnit(joint);
            const label = window.i18n.t(side === 'primary' ? 'posePrimary' : 'poseReference') + ' · ' + joint.name;
            number.setAttribute('aria-label', label + ' (' + unit.textContent + ')');
            range.setAttribute('aria-label', label);
            range.setAttribute('aria-valuetext', text + ' ' + unit.textContent);
        }
    }
}
