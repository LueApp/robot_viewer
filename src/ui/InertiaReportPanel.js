import { parseInertiaReport, decodeInertiaReport, InertiaReportPreview } from '../utils/InertiaReport.js';
import './inertia-report.css';

export class InertiaReportPanel {
    constructor(app) {
        this.app = app;
        this.model = null;
        this.records = [];
        this.filename = '';
        this.selected = '';
        this.preview = new InertiaReportPreview();
        this.visibility = new Map();
        this.loadSequence = 0;
        this.panel = document.getElementById('floating-inertia-report-panel');
        this.get = name => this.panel.querySelector(`[data-report-${name}]`);
        this.get('upload').onclick = () => this.get('file').click();
        this.get('file').onchange = async event => {
            const file = event.target.files?.[0];
            if (file) await this.loadFile(file);
            event.target.value = '';
        };
        this.get('clear').onclick = () => this.clear();
        this.get('preview').onchange = () => { this.applyPreview(); this.render(); };
        this.get('filter').oninput = () => this.renderRows();
        this.render();
    }

    t(key) { return window.i18n.t(key); }
    format(value) { return value !== 0 && Math.abs(value) < 1e-8 ? value.toExponential(6) : value.toFixed(8); }

    async loadFile(file) {
        const sequence = ++this.loadSequence;
        this.panel.style.display = 'flex';
        document.getElementById('toggle-inertia-report-panel').classList.add('active');
        this.get('error').textContent = '';
        try {
            if (!/\.txt$/i.test(file.name)) throw new Error(this.t('inertiaReportTextOnly'));
            if (file.size > 5 * 1024 * 1024) throw new Error(this.t('inertiaReportTooLarge'));
            const records = parseInertiaReport(decodeInertiaReport(await file.arrayBuffer()));
            if (sequence !== this.loadSequence) return;
            this.records = records;
            this.filename = file.name;
            this.selected = records[0].name;
            this.get('filter').value = '';
            this.get('preview').checked = true;
            this.applyPreview();
            this.render();
        } catch (error) {
            if (sequence === this.loadSequence) this.get('error').textContent = error.message;
        }
    }

    setModel(model) {
        // CAD coordinate systems map directly to URDF/Xacro link frames.
        this.model = model?.threeObject?.userData?.type === 'urdf' ? model : null;
        this.applyPreview();
        this.render();
    }

    restorePreview() {
        this.preview.restore();
        const visualization = this.app.sceneManager.inertialVisualization;
        for (const [name, previous] of this.visibility) {
            if (!previous.com) visualization.perLinkCOM.delete(name);
            if (!previous.inertia) visualization.perLinkInertia.delete(name);
        }
        this.visibility.clear();
    }

    applyPreview() {
        const hadPreview = this.visibility.size > 0;
        this.restorePreview();
        const scene = this.app.sceneManager;
        const visualization = scene.inertialVisualization;
        if (this.model && this.get('preview').checked) {
            this.preview.apply(this.model, this.records);
            for (const record of this.records) {
                if (!this.model.links.has(record.name)) continue;
                this.visibility.set(record.name, {
                    com: visualization.perLinkCOM.has(record.name),
                    inertia: visualization.perLinkInertia.has(record.name)
                });
                visualization.perLinkCOM.add(record.name);
                visualization.perLinkInertia.add(record.name);
            }
        }
        if (!hadPreview && !this.visibility.size) return;
        // Clear selection materials before rebuilding the auxiliary meshes.
        const highlighted = scene.highlightManager.currentHighlightedLink;
        if (highlighted) scene.highlightManager.unhighlightLink(highlighted, scene.currentModel);
        if (scene.currentModel) visualization.extractInertialProperties(scene.currentModel);
        scene.updateVisualTransparency();
        scene.gravityUI?.update();
        scene.redraw();
    }

    clear() {
        ++this.loadSequence;
        this.records = [];
        this.filename = '';
        this.selected = '';
        this.get('error').textContent = '';
        this.get('filter').value = '';
        this.applyPreview();
        this.render();
    }

    render() {
        const count = this.records.length;
        const matched = this.records.filter(record => this.model?.links.has(record.name));
        this.get('filename').textContent = this.filename || this.t('inertiaReportEmpty');
        this.get('clear').disabled = !count;
        this.get('preview').disabled = !matched.length;
        this.get('summary').textContent = count
            ? `${count} ${this.t('inertiaReportRecords')} · ${this.t('inertiaReportTotal')}: ${this.records.reduce((sum, record) => sum + record.inertial.mass, 0).toFixed(6)} kg`
            : this.t('inertiaReportHint');
        this.get('match').textContent = count
            ? this.model
                ? `${matched.length}/${count} ${this.t('inertiaReportMatched')} · ${this.t('inertiaReportMatchedMass')}: ${matched.reduce((sum, record) => sum + record.inertial.mass, 0).toFixed(6)} kg`
                : this.t('inertiaReportLoadModel')
            : '';
        this.get('data').hidden = !count;
        this.get('filter').setAttribute('aria-label', this.t('inertiaReportFilter'));
        this.renderRows();
        this.renderDetail();
    }

    renderRows() {
        const filter = this.get('filter').value.trim().toLowerCase();
        const rows = this.records.filter(record => record.name.toLowerCase().includes(filter)).map(record => {
            const row = document.createElement('tr');
            row.dataset.link = record.name;
            row.classList.toggle('selected', record.name === this.selected);
            const nameCell = document.createElement('td');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'inertia-report-link';
            button.textContent = record.name;
            button.title = record.name;
            button.setAttribute('aria-pressed', String(record.name === this.selected));
            button.onclick = () => {
                this.selected = record.name;
                const link = this.model?.links.get(record.name);
                if (link) this.app.sceneManager.highlightManager.highlightLink(link, this.model);
                this.renderRows(); this.renderDetail();
            };
            nameCell.append(button);
            row.append(nameCell);
            for (const number of [record.inertial.mass, ...record.inertial.origin.xyz]) {
                const cell = document.createElement('td');
                cell.textContent = this.format(number);
                row.append(cell);
            }
            const status = document.createElement('td');
            status.textContent = this.t(this.model?.links.has(record.name) ? 'inertiaReportMatch' : 'inertiaReportUnmatched');
            row.append(status);
            return row;
        });
        this.get('rows').replaceChildren(...rows);
        this.get('no-results').hidden = Boolean(rows.length);
    }

    renderDetail() {
        const record = this.records.find(value => value.name === this.selected);
        if (!record) return;
        const i = record.inertial;
        this.get('selected').textContent = record.name;
        this.get('mass').textContent = `${this.format(i.mass)} kg`;
        this.get('com').textContent = i.origin.xyz.map(value => this.format(value)).join(', ') + ' m';
        const matrix = [[i.ixx, i.ixy, i.ixz], [i.ixy, i.iyy, i.iyz], [i.ixz, i.iyz, i.izz]];
        this.get('tensor').replaceChildren(...matrix.map((values, index) => {
            const row = document.createElement('tr');
            const label = document.createElement('th');
            label.scope = 'row'; label.textContent = ['X', 'Y', 'Z'][index];
            row.append(label);
            for (const value of values) {
                const cell = document.createElement('td'); cell.textContent = this.format(value); row.append(cell);
            }
            return row;
        }));
    }
}
