import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { URDFOverlay } from '../renderer/URDFOverlay.js';
import './urdf-comparison.css';

export class URDFComparison {
    constructor(scene, fileHandler) {
        this.scene = scene;
        this.fileHandler = fileHandler;
        this.sequence = 0;
        this.panel = document.getElementById('urdf-comparison');
        this.get = name => this.panel.querySelector(`[data-${name}]`);
        this.select = this.get('reference-select');
        this.select.onchange = () => this.load(this.sources.find(source => source.key === this.select.value));
        this.get('show-overlay').onchange = event => {
            if (scene.comparisonOverlay) {
                scene.comparisonOverlay.root.visible = event.target.checked;
                this.updateViewControls();
                scene.redraw();
            }
        };
        this.setupViewControls();
        this.setPrimary(null);
    }

    setupViewControls() {
        this.viewBar = document.getElementById('comparison-view');
        this.divider = document.getElementById('comparison-divider');
        this.mix = document.getElementById('comparison-mix');
        const scene = this.scene;
        const apply = () => {
            scene.comparisonOverlay?.setView(scene.comparisonView, scene.comparisonOpacity);
            this.updateViewControls();
            scene.redraw();
        };
        for (const button of this.viewBar.querySelectorAll('[data-view]')) {
            button.onclick = () => {
                scene.comparisonView = button.dataset.view;
                apply();
            };
        }
        this.mix.oninput = () => {
            const fraction = this.mix.valueAsNumber / 100;
            if (scene.comparisonView === 'wipe') scene.comparisonSplit = fraction;
            else scene.comparisonOpacity = fraction;
            apply();
        };
        const drag = event => {
            const rect = scene.canvas.getBoundingClientRect();
            scene.comparisonSplit = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            this.updateViewControls();
            scene.redraw();
        };
        this.divider.onpointerdown = event => {
            if (event.button !== 0) return;
            this.divider.setPointerCapture(event.pointerId);
            drag(event);
        };
        this.divider.onpointermove = event => {
            if (this.divider.hasPointerCapture(event.pointerId)) drag(event);
        };
        scene.on('comparisonChanged', () => this.updateViewControls());
    }

    updateViewControls() {
        const scene = this.scene;
        const visible = Boolean(scene.comparisonOverlay?.root.visible);
        const wipe = scene.comparisonView === 'wipe';
        this.viewBar.hidden = !visible;
        this.divider.hidden = !visible || !wipe;
        this.divider.style.left = (scene.comparisonSplit * 100) + '%';
        for (const button of this.viewBar.querySelectorAll('[data-view]')) {
            button.setAttribute('aria-pressed', String(button.dataset.view === scene.comparisonView));
        }
        this.mix.value = Math.round((wipe ? scene.comparisonSplit : scene.comparisonOpacity) * 100);
        this.viewBar.querySelector('[data-mix-value]').textContent = this.mix.value + '%';
        const label = this.viewBar.querySelector('[data-mix-label]');
        label.dataset.i18n = wipe ? 'compareSplit' : 'compareOpacity';
        label.textContent = window.i18n.t(label.dataset.i18n);
    }

    setPrimary(file, resetReference = false) {
        this.primary = file;
        if (!file || resetReference || file === this.active?.file || file === this.loading?.file) this.clearReference();
        this.panel.hidden = !file;
        this.refreshProjects();
    }

    clearReference() {
        ++this.sequence;
        this.loading = this.active = null;
        if (this.scene.comparisonOverlay) this.scene.setComparisonOverlay(null);
        this.get('overlay-control').hidden = true;
        this.get('comparison-status').textContent = '';
    }

    refreshProjects() {
        const projects = this.fileHandler.projects;
        if (this.loading && !projects.has(this.loading.project.id)) {
            ++this.sequence;
            this.loading = null;
            this.get('comparison-status').textContent = '';
        }
        if (this.active && !projects.has(this.active.project.id)) {
            this.active = null;
            this.scene.setComparisonOverlay(null);
            this.get('overlay-control').hidden = true;
        }
        this.sources = [];
        const empty = new Option(window.i18n.t('comparisonNone'), '');
        empty.dataset.i18n = 'comparisonNone';
        this.select.replaceChildren(empty);
        for (const project of projects.values()) {
            const group = document.createElement('optgroup');
            group.label = project.name;
            for (const model of project.models) {
                const path = model.path;
                const file = project.assets.get(path);
                if (!file || !/\.urdf$/i.test(file.name) || file === this.primary) continue;
                const source = { project, path, file, assets: project.assets, key: project.id + '/' + path };
                this.sources.push(source);
                const relative = project.loose ? path : path.replace(/^\/?[^/]+\//, '');
                const label = path === project.name ? path : project.name + ' / ' + relative;
                group.append(new Option(label, source.key));
            }
            if (group.children.length) this.select.append(group);
        }
        const chosen = this.loading || this.active;
        this.select.value = chosen?.key || '';
        this.showReferenceName(chosen);
        this.select.disabled = !this.sources.length;
    }

    showReferenceName(source) {
        this.get('reference-name').textContent = source?.file.name || window.i18n.t('comparisonNone');
        this.get('reference-project').textContent = source?.project.name || '';
        this.select.title = this.select.selectedOptions[0]?.text || '';
    }

    async load(source) {
        const sequence = ++this.sequence;
        const status = this.get('comparison-status');
        this.panel.open = true;
        this.loading = source;
        status.textContent = '';
        let overlay = null;
        if (source) {
            this.select.value = source.key;
            this.showReferenceName(source);
            status.textContent = window.i18n.t('comparisonLoading');
            try {
                const content = await source.file.text();
                if (sequence !== this.sequence) return;
                const model = await ModelLoaderFactory.loadURDF(content, source.path, source.assets, source.file, { visualOnly: true });
                overlay = new URDFOverlay(model);
                if (sequence !== this.sequence) {
                    overlay.dispose();
                    return;
                }
            } catch (error) {
                if (sequence === this.sequence) {
                    this.loading = null;
                    status.textContent = `${window.i18n.t('loadFailed')} · ${source.path} · ${error.message}`;
                    this.refreshProjects();
                }
                return;
            }
        }
        this.scene.setComparisonOverlay(overlay);
        this.loading = null;
        this.active = source;
        this.refreshProjects();
        this.get('overlay-control').hidden = !source;
        this.get('show-overlay').checked = true;
        status.textContent = '';
    }
}
