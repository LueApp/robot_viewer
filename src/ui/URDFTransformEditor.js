import { XMLUpdater } from '../utils/XMLUpdater.js';

/**
 * Structured editor for URDF visual/collision origins and joint frames/axes.
 * The XML editor remains the source of truth; applying a change rewrites the
 * relevant tag and asks CodeEditorManager to reload the preview.
 */
export class URDFTransformEditor {
    constructor(codeEditorManager) {
        this.codeEditorManager = codeEditorManager;
        this.model = null;
        this.file = null;
        this.parsed = null;
        this.isSupported = false;
        this.isApplying = false;
        this.refreshTimer = null;

        this.cacheElements();
        this.setupEvents();

        this.unsubscribeEditor = this.codeEditorManager.subscribeToContentChanges(() => {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => this.refreshFromEditor(), 120);
        });
    }

    cacheElements() {
        this.panel = document.getElementById('floating-urdf-transform-panel');
        this.linkSelect = document.getElementById('urdf-transform-link');
        this.geometrySelect = document.getElementById('urdf-transform-geometry');
        this.jointSelect = document.getElementById('urdf-transform-joint');
        this.geometryFieldset = document.getElementById('urdf-geometry-fields');
        this.meshScaleFields = document.getElementById('urdf-mesh-scale-fields');
        this.mirrorButtons = Array.from(document.querySelectorAll('[data-urdf-mirror-axis]'));
        this.jointFieldset = document.getElementById('urdf-joint-fields');
        this.axisFields = document.getElementById('urdf-axis-fields');
        this.reverseLimitsOption = document.getElementById('urdf-reverse-limits-option');
        this.reverseLimitsCheckbox = document.getElementById('urdf-reverse-limits');
        this.geometryApplyButton = document.getElementById('urdf-apply-geometry');
        this.jointApplyButton = document.getElementById('urdf-apply-joint');
        this.status = document.getElementById('urdf-transform-status');
    }

    setupEvents() {
        this.linkSelect?.addEventListener('change', () => {
            this.populateGeometrySelect();
            const attachedJoint = this.parsed?.joints.find(joint => joint.child === this.linkSelect.value);
            if (attachedJoint && this.jointSelect) {
                this.jointSelect.value = attachedJoint.name;
                this.loadSelectedJoint();
            }
        });
        this.geometrySelect?.addEventListener('change', () => this.loadSelectedGeometry());
        this.jointSelect?.addEventListener('change', () => this.loadSelectedJoint());
        this.geometryApplyButton?.addEventListener('click', () => this.applyGeometry());
        this.jointApplyButton?.addEventListener('click', () => this.applyJoint());
        this.mirrorButtons.forEach(button => {
            button.addEventListener('click', () => this.toggleMeshMirror(button.dataset.urdfMirrorAxis));
        });

        document.getElementById('toggle-urdf-transform-panel')?.addEventListener('click', () => {
            setTimeout(() => this.refreshFromEditor(), 0);
        });
    }

    setModel(model, file) {
        this.model = model;
        this.file = file;
        const extension = file?.name?.split('.').pop()?.toLowerCase();
        this.isSupported = model?.threeObject?.userData?.type === 'urdf' && extension !== 'xacro';
        this.showStatus('', 'info');
        this.refreshFromEditor();
    }

    parseVector(value, fallback) {
        if (!value) return [...fallback];
        const values = value.trim().split(/\s+/).map(Number);
        return values.length === 3 && values.every(Number.isFinite) ? values : [...fallback];
    }

    directChild(element, tagName) {
        return Array.from(element?.children || []).find(child => child.localName === tagName) || null;
    }

    readOrigin(element) {
        const origin = this.directChild(element, 'origin');
        return {
            xyz: this.parseVector(origin?.getAttribute('xyz'), [0, 0, 0]),
            rpy: this.parseVector(origin?.getAttribute('rpy'), [0, 0, 0])
        };
    }

    parseURDF(content) {
        const documentNode = new DOMParser().parseFromString(content, 'text/xml');
        if (documentNode.querySelector('parsererror') || documentNode.documentElement?.localName !== 'robot') {
            throw new Error(window.i18n.t('urdfInvalidDocument'));
        }

        const links = Array.from(documentNode.getElementsByTagName('link')).map(linkElement => {
            const geometries = [];
            ['visual', 'collision'].forEach(type => {
                const elements = Array.from(linkElement.children).filter(child => child.localName === type);
                elements.forEach((element, index) => {
                    const geometry = this.directChild(element, 'geometry');
                    const shape = Array.from(geometry?.children || [])[0];
                    const shapeType = shape?.localName || 'geometry';
                    const filename = shapeType === 'mesh' ? shape.getAttribute('filename') : null;
                    geometries.push({
                        key: `${type}:${index}`,
                        type,
                        index,
                        shapeType,
                        filename,
                        scale: shapeType === 'mesh'
                            ? this.parseVector(shape.getAttribute('scale'), [1, 1, 1])
                            : null,
                        origin: this.readOrigin(element)
                    });
                });
            });

            return { name: linkElement.getAttribute('name'), geometries };
        }).filter(link => link.name);

        const joints = Array.from(documentNode.getElementsByTagName('joint')).map(jointElement => {
            const parent = this.directChild(jointElement, 'parent');
            const child = this.directChild(jointElement, 'child');
            const axis = this.directChild(jointElement, 'axis');
            const limit = this.directChild(jointElement, 'limit');
            const lowerText = limit?.getAttribute('lower');
            const upperText = limit?.getAttribute('upper');
            const lower = lowerText?.trim() ? Number(lowerText) : NaN;
            const upper = upperText?.trim() ? Number(upperText) : NaN;
            return {
                name: jointElement.getAttribute('name'),
                type: jointElement.getAttribute('type') || 'fixed',
                parent: parent?.getAttribute('link') || '',
                child: child?.getAttribute('link') || '',
                origin: this.readOrigin(jointElement),
                axis: this.parseVector(axis?.getAttribute('xyz'), [1, 0, 0]),
                limits: Number.isFinite(lower) && Number.isFinite(upper)
                    ? { lower, upper }
                    : null
            };
        }).filter(joint => joint.name);

        return { links, joints };
    }

    refreshFromEditor() {
        if (!this.linkSelect || !this.jointSelect) return;

        const content = this.codeEditorManager.getEditor()?.getValue() || '';
        if (!this.isSupported || !content.trim()) {
            this.parsed = null;
            this.populateSelect(this.linkSelect, [], '');
            this.populateSelect(this.geometrySelect, [], '');
            this.populateSelect(this.jointSelect, [], '');
            this.setEditorEnabled(false);
            this.showStatus(window.i18n.t('urdfOnlyHint'), 'info');
            return;
        }

        try {
            const oldLink = this.linkSelect.value;
            const oldGeometry = this.geometrySelect?.value;
            const oldJoint = this.jointSelect.value;
            this.parsed = this.parseURDF(content);

            this.populateSelect(
                this.linkSelect,
                this.parsed.links.map(link => ({ value: link.name, label: link.name })),
                oldLink
            );
            this.populateGeometrySelect(oldGeometry);
            this.populateSelect(
                this.jointSelect,
                this.parsed.joints.map(joint => ({
                    value: joint.name,
                    label: `${joint.name} (${joint.type})`
                })),
                oldJoint
            );
            this.loadSelectedJoint();
            this.setEditorEnabled(true);
            if (this.status?.dataset.type === 'error' && !this.isApplying) {
                this.showStatus('', 'info');
            }
        } catch (error) {
            this.parsed = null;
            this.populateSelect(this.linkSelect, [], '');
            this.populateSelect(this.geometrySelect, [], '');
            this.populateSelect(this.jointSelect, [], '');
            this.setEditorEnabled(false);
            this.showStatus(error.message, 'error');
        }
    }

    populateSelect(select, options, preferredValue) {
        if (!select) return;
        select.innerHTML = '';
        options.forEach(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            select.appendChild(element);
        });
        if (options.some(option => option.value === preferredValue)) select.value = preferredValue;
        select.disabled = options.length === 0;
    }

    geometryLabel(geometry) {
        const typeLabel = window.i18n.t(geometry.type === 'visual' ? 'visual' : 'collision');
        const fileLabel = geometry.filename?.split(/[\\/]/).pop();
        const detail = fileLabel || geometry.shapeType;
        return `${typeLabel} ${geometry.index + 1} — ${detail}`;
    }

    populateGeometrySelect(preferredValue = '') {
        const link = this.parsed?.links.find(item => item.name === this.linkSelect?.value);
        const options = (link?.geometries || []).map(geometry => ({
            value: geometry.key,
            label: this.geometryLabel(geometry)
        }));
        this.populateSelect(this.geometrySelect, options, preferredValue);
        this.loadSelectedGeometry();
    }

    setVector(prefix, values) {
        ['x', 'y', 'z'].forEach((axis, index) => {
            const input = document.getElementById(`${prefix}-${axis}`);
            if (input) input.value = Number(values[index].toPrecision(8)).toString();
        });
    }

    readVector(prefix) {
        const values = ['x', 'y', 'z'].map(axis => {
            const value = document.getElementById(`${prefix}-${axis}`)?.value.trim();
            return value === '' || value === undefined ? NaN : Number(value);
        });
        if (values.some(value => !Number.isFinite(value))) {
            throw new Error(window.i18n.t('urdfInvalidVector'));
        }
        return values;
    }

    loadSelectedGeometry() {
        const link = this.parsed?.links.find(item => item.name === this.linkSelect?.value);
        const geometry = link?.geometries.find(item => item.key === this.geometrySelect?.value);
        this.geometryFieldset?.toggleAttribute('disabled', !geometry || this.isApplying);
        const isMesh = geometry?.shapeType === 'mesh';
        this.meshScaleFields?.toggleAttribute('disabled', !isMesh || this.isApplying);
        if (!geometry) {
            this.updateMirrorButtons([1, 1, 1], false);
            return;
        }
        this.setVector('urdf-geometry-position', geometry.origin.xyz);
        this.setVector('urdf-geometry-rotation', geometry.origin.rpy);
        this.setVector('urdf-mesh-scale', geometry.scale || [1, 1, 1]);
        this.updateMirrorButtons(geometry.scale || [1, 1, 1], isMesh);
    }

    updateMirrorButtons(scale, enabled = true) {
        const axes = ['x', 'y', 'z'];
        this.mirrorButtons.forEach(button => {
            const index = axes.indexOf(button.dataset.urdfMirrorAxis);
            button.classList.toggle('active', enabled && index >= 0 && scale[index] < 0);
            button.disabled = !enabled || this.isApplying;
        });
    }

    toggleMeshMirror(axis) {
        const axes = ['x', 'y', 'z'];
        const index = axes.indexOf(axis);
        if (index < 0) return;

        try {
            const scale = this.readVector('urdf-mesh-scale');
            if (Math.abs(scale[index]) < 1e-12) {
                throw new Error(window.i18n.t('urdfZeroScale'));
            }
            scale[index] *= -1;
            this.setVector('urdf-mesh-scale', scale);
            this.updateMirrorButtons(scale);
            this.showStatus(window.i18n.t('urdfMirrorPending'), 'info');
        } catch (error) {
            this.showStatus(error.message, 'error');
        }
    }

    loadSelectedJoint() {
        const joint = this.parsed?.joints.find(item => item.name === this.jointSelect?.value);
        this.jointFieldset?.toggleAttribute('disabled', !joint || this.isApplying);
        if (!joint) {
            this.setReverseLimitsEnabled(false);
            return;
        }
        this.setVector('urdf-joint-position', joint.origin.xyz);
        this.setVector('urdf-joint-rotation', joint.origin.rpy);
        this.setVector('urdf-joint-axis', joint.axis);

        const hasMotionAxis = !['fixed', 'floating'].includes(joint.type);
        this.axisFields?.toggleAttribute('disabled', !hasMotionAxis || this.isApplying);
        this.setReverseLimitsEnabled(this.canReverseJointLimits(joint));
    }

    canReverseJointLimits(joint) {
        return Boolean(
            joint?.limits
            && !['continuous', 'fixed', 'floating'].includes(joint.type)
        );
    }

    setReverseLimitsEnabled(enabled) {
        const isEnabled = enabled && !this.isApplying;
        if (this.reverseLimitsCheckbox) this.reverseLimitsCheckbox.disabled = !isEnabled;
        this.reverseLimitsOption?.classList.toggle('disabled', !isEnabled);
    }

    setEditorEnabled(enabled) {
        this.linkSelect.disabled = !enabled || !this.parsed?.links.length;
        this.geometrySelect.disabled = !enabled || !this.geometrySelect.options.length;
        this.jointSelect.disabled = !enabled || !this.parsed?.joints.length;
        this.geometryFieldset?.toggleAttribute('disabled', !enabled || this.isApplying);
        this.jointFieldset?.toggleAttribute('disabled', !enabled || this.isApplying);
        if (enabled) {
            this.loadSelectedGeometry();
            this.loadSelectedJoint();
        }
    }

    setApplying(isApplying) {
        this.isApplying = isApplying;
        this.geometryApplyButton?.toggleAttribute('disabled', isApplying);
        this.jointApplyButton?.toggleAttribute('disabled', isApplying);
        this.loadSelectedGeometry();
        this.loadSelectedJoint();
    }

    async commit(updatedContent) {
        const editor = this.codeEditorManager.getEditor();
        if (!editor) throw new Error(window.i18n.t('urdfNoEditor'));
        editor.setValue(updatedContent);
        this.showStatus(window.i18n.t('urdfReloading'), 'info');
        const reloaded = await this.codeEditorManager.reloadFromEditor();
        if (!reloaded) throw new Error(window.i18n.t('reloadFailed'));
        this.showStatus(window.i18n.t('urdfApplied'), 'success');
    }

    async applyGeometry() {
        if (this.isApplying) return;
        try {
            const link = this.parsed?.links.find(item => item.name === this.linkSelect.value);
            const geometry = link?.geometries.find(item => item.key === this.geometrySelect.value);
            if (!link || !geometry) throw new Error(window.i18n.t('urdfSelectGeometry'));

            const origin = {
                xyz: this.readVector('urdf-geometry-position'),
                rpy: this.readVector('urdf-geometry-rotation')
            };
            let content = this.codeEditorManager.getEditor().getValue();
            content = XMLUpdater.updateURDFGeometryOrigin(
                content,
                link.name,
                geometry.type,
                geometry.index,
                origin
            );

            if (geometry.shapeType === 'mesh') {
                const scale = this.readVector('urdf-mesh-scale');
                if (scale.some(value => Math.abs(value) < 1e-12)) {
                    throw new Error(window.i18n.t('urdfZeroScale'));
                }
                const scaleChanged = scale.some((value, index) =>
                    Math.abs(value - geometry.scale[index]) > 1e-12
                );
                if (scaleChanged) {
                    content = XMLUpdater.updateURDFMeshScale(
                        content,
                        link.name,
                        geometry.type,
                        geometry.index,
                        scale
                    );
                }
            }
            this.setApplying(true);
            await this.commit(content);
        } catch (error) {
            this.showStatus(error.message, 'error');
        } finally {
            this.setApplying(false);
        }
    }

    async applyJoint() {
        if (this.isApplying) return;
        try {
            const joint = this.parsed?.joints.find(item => item.name === this.jointSelect.value);
            if (!joint) throw new Error(window.i18n.t('urdfSelectJoint'));

            const origin = {
                xyz: this.readVector('urdf-joint-position'),
                rpy: this.readVector('urdf-joint-rotation')
            };
            let content = this.codeEditorManager.getEditor().getValue();
            content = XMLUpdater.updateURDFJointOrigin(content, joint.name, origin);

            if (!['fixed', 'floating'].includes(joint.type)) {
                const axis = this.readVector('urdf-joint-axis');
                const length = Math.hypot(...axis);
                if (length < 1e-9) throw new Error(window.i18n.t('urdfZeroAxis'));
                const normalizedAxis = axis.map(value => value / length);
                content = XMLUpdater.updateURDFJointAxis(
                    content,
                    joint.name,
                    normalizedAxis
                );

                const oldAxisLength = Math.hypot(...joint.axis);
                const oldAxis = oldAxisLength >= 1e-9
                    ? joint.axis.map(value => value / oldAxisLength)
                    : null;
                const directionDot = oldAxis
                    ? oldAxis.reduce((sum, value, index) => sum + value * normalizedAxis[index], 0)
                    : 1;
                if (
                    this.reverseLimitsCheckbox?.checked
                    && this.canReverseJointLimits(joint)
                    && directionDot < -0.999999
                ) {
                    content = XMLUpdater.reverseURDFJointLimits(content, joint.name);
                }
            }

            this.setApplying(true);
            await this.commit(content);
        } catch (error) {
            this.showStatus(error.message, 'error');
        } finally {
            this.setApplying(false);
        }
    }

    showStatus(message, type = 'info') {
        if (!this.status) return;
        this.status.textContent = message;
        this.status.dataset.type = type;
        this.status.hidden = !message;
    }

    open() {
        if (!this.panel) return;
        this.panel.style.display = 'flex';
        document.getElementById('toggle-urdf-transform-panel')?.classList.add('active');
        this.refreshFromEditor();
    }

    selectLink(linkName, open = false) {
        if (open) this.open();
        this.refreshFromEditor();
        if (!Array.from(this.linkSelect?.options || []).some(option => option.value === linkName)) return;
        this.linkSelect.value = linkName;
        this.linkSelect.dispatchEvent(new Event('change'));
    }

    selectJoint(jointName, open = false) {
        if (open) this.open();
        this.refreshFromEditor();
        if (!Array.from(this.jointSelect?.options || []).some(option => option.value === jointName)) return;
        this.jointSelect.value = jointName;
        this.loadSelectedJoint();
    }
}
