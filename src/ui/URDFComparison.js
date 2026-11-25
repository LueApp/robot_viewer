import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { URDFOverlay } from '../renderer/URDFOverlay.js';
import './urdf-comparison.css';

function urdfSources(assets) {
    const sources = new Map();
    for (const [path, file] of assets) {
        if (/\.urdf$/i.test(file.name)) sources.set(file, { path, file, assets });
    }
    return [...sources.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function folderSources(files) {
    return urdfSources(new Map(files.map(file => [file.webkitRelativePath || file.name, file])));
}

function setOptions(select, sources, selected, emptyKey) {
    const empty = new Option(window.i18n.t(emptyKey), '');
    empty.dataset.i18n = emptyKey;
    select.replaceChildren(empty);
    for (const [i, source] of sources.entries()) select.add(new Option(source.path, String(i)));
    const index = sources.findIndex(source => source.file === selected?.file);
    if (selected && index < 0) {
        // Keep the displayed version identifiable while choosing from a different folder.
        const current = new Option(`${window.i18n.t('comparisonCurrent')} · ${selected.path}`, 'current');
        current.disabled = true;
        select.add(current);
        select.value = current.value;
    } else {
        select.value = index < 0 ? '' : String(index);
    }
    select.disabled = !sources.length && !selected;
    return empty;
}

export class URDFComparison {
    constructor(scene, fileHandler) {
        this.scene = scene;
        this.fileHandler = fileHandler;
        this.sequence = 0;
        this.primarySequence = 0;
        this.panel = document.getElementById('urdf-comparison');
        this.get = name => this.panel.querySelector(`[data-${name}]`);
        this.select = this.get('reference-select');
        this.primarySelect = this.get('primary-select');
        this.primarySelect.onchange = () => this.loadPrimary(this.primarySources[this.primarySelect.value]);
        this.select.onchange = () => this.load(this.sources[this.select.value]);
        this.get('show-overlay').onchange = event => {
            if (scene.comparisonOverlay) {
                scene.comparisonOverlay.root.visible = event.target.checked;
                this.updateViewControls();
                scene.redraw();
            }
        };
        this.setupViewControls();
        this.bindPicker('open-primary-folder', 'primary-folder', files => this.importPrimaryFiles(files));
        this.bindPicker('open-folder', 'reference-folder', files => this.importFiles(files));
        this.bindPicker('open-files', 'reference-files', files => this.importFiles(files));
        this.setPrimary(null, new Map());
        this.panel.hidden = false;
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

    bindPicker(buttonName, inputName, onFiles) {
        const input = this.get(inputName);
        this.get(buttonName).onclick = () => input.click();
        input.onchange = () => {
            if (input.files.length) onFiles(Array.from(input.files));
            input.value = '';
        };
    }

    setPrimary(file, assets, keepReference = false) {
        ++this.primarySequence;
        this.primarySources = file ? urdfSources(new Map(assets)) : [];
        this.primary = this.primarySources.find(source => source.file === file);
        if (file && !this.primary) {
            this.primary = { file, path: file.name, assets: new Map(assets) };
            this.primarySources.push(this.primary);
        }
        this.workspace = this.primarySources.filter(source => source !== this.primary);
        this.renderPrimaryOptions();
        this.get('primary-status').textContent = '';
        if (!keepReference) {
            ++this.sequence;
            if (this.scene.comparisonOverlay) this.scene.setComparisonOverlay(null);
            this.stagedOverlay?.dispose();
            this.stagedOverlay = null;
            this.active = null;
            this.loading = null;
            this.referenceSources = [];
            this.panel.open = false;
            this.get('overlay-control').hidden = true;
            this.get('comparison-status').textContent = '';
        }
        this.renderReferenceOptions();
    }

    renderPrimaryOptions() {
        setOptions(this.primarySelect, this.primarySources, this.primary, 'comparisonChoosePrimary').disabled = true;
    }

    renderReferenceOptions() {
        this.sources = this.referenceSources.length ? this.referenceSources : this.workspace;
        setOptions(this.select, this.sources, this.loading || this.active, 'comparisonNone');
    }

    importPrimaryFiles(files) {
        ++this.primarySequence;
        const imported = folderSources(files);
        if (!imported.length) {
            this.get('primary-status').textContent = window.i18n.t('comparisonNoURDF');
            this.renderPrimaryOptions();
            return;
        }
        this.primarySources = imported;
        this.renderPrimaryOptions();
        if (imported.length === 1) return this.loadPrimary(imported[0]);
        this.get('primary-status').textContent = window.i18n.t('comparisonChoosePrimary');
    }

    async loadPrimary(source) {
        const sequence = ++this.primarySequence;
        const isCurrent = () => sequence === this.primarySequence;
        const status = this.get('primary-status');
        this.primarySelect.value = String(this.primarySources.indexOf(source));
        status.textContent = window.i18n.t('comparisonLoadingPrimary');
        try {
            await this.fileHandler.loadComparisonPrimary(source, isCurrent);
        } catch (error) {
            if (isCurrent()) {
                status.textContent = `${window.i18n.t('loadFailed')} · ${source.path} · ${error.message}`;
                this.renderPrimaryOptions();
            }
        }
    }

    importFiles(files) {
        ++this.sequence;
        this.loading = null;
        const imported = folderSources(files);
        if (!imported.length) {
            this.get('comparison-status').textContent = window.i18n.t('comparisonNoURDF');
            this.renderReferenceOptions();
            return;
        }
        this.referenceSources = imported;
        this.renderReferenceOptions();
        if (imported.length === 1) return this.load(imported[0]);
        this.get('comparison-status').textContent = window.i18n.t('comparisonChoose');
    }

    // A reference chosen first is ready to attach as soon as the primary enters the scene.
    attachStagedReference() {
        if (!this.stagedOverlay) return;
        this.scene.setComparisonOverlay(this.stagedOverlay);
        this.stagedOverlay = null;
        this.get('overlay-control').hidden = false;
        this.get('comparison-status').textContent = '';
    }

    async load(source) {
        const sequence = ++this.sequence;
        const status = this.get('comparison-status');
        this.panel.open = true;
        this.loading = source;
        status.textContent = '';
        let overlay = null;
        if (source) {
            this.select.value = String(this.sources.indexOf(source));
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
                    this.renderReferenceOptions();
                }
                return;
            }
        }
        this.stagedOverlay?.dispose();
        this.stagedOverlay = this.primary ? null : overlay;
        if (this.primary) this.scene.setComparisonOverlay(overlay);
        this.loading = null;
        this.active = source;
        this.renderReferenceOptions();
        this.get('overlay-control').hidden = !source || !this.primary;
        this.get('show-overlay').checked = true;
        status.textContent = this.stagedOverlay ? window.i18n.t('comparisonWaitingPrimary') : '';
    }
}
