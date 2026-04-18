import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CoordinateAxesManager } from './CoordinateAxesManager.js';

/**
 * CopiedFrameManager - Manages copied coordinate frames and joint axes
 * Allows users to duplicate frames, then translate/rotate them via
 * a TransformControls gizmo and a numeric input panel.
 */
export class CopiedFrameManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.copiedFrames = new Map(); // id -> frameData
        this.transformControls = null;
        this.selectedFrameId = null;
        this._nextId = 0;
        this._panel = null;
        this._listEl = null;
    }

    // ==================== Copy Operations ====================

    /**
     * Copy a link's coordinate frame
     */
    copyLinkFrame(linkName, model) {
        if (!model || !model.links) return;
        const link = model.links.get(linkName);
        if (!link || !link.threeObject) return;

        // Get world transform
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        link.threeObject.getWorldPosition(worldPos);
        link.threeObject.getWorldQuaternion(worldQuat);

        // Compute axes size from link bounding box (same logic as CoordinateAxesManager)
        const box = new THREE.Box3().setFromObject(link.threeObject);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        const axesSize = Math.min(0.5, Math.max(0.03, maxDim * 0.25));

        // Create geometry
        const group = CoordinateAxesManager.createAxesGeometry(axesSize);
        this._applyPastelColors(group);
        this._markAsCopiedFrame(group);

        // Position in world space
        group.position.copy(worldPos);
        group.quaternion.copy(worldQuat);

        const id = `copy_frame_${this._nextId++}`;
        const label = `${linkName}`;

        // Set id on group for click-selection
        group.userData.copiedFrameId = id;

        this.sceneManager.scene.add(group);

        const frameData = {
            id,
            type: 'frame',
            sourceLinkName: linkName,
            label,
            originalWorldPosition: worldPos.clone(),
            originalWorldQuaternion: worldQuat.clone(),
            threeObject: group,
            translationOffset: new THREE.Vector3(),
            rotationOffset: new THREE.Euler(0, 0, 0, 'XYZ'),
            panelEntry: null
        };

        this.copiedFrames.set(id, frameData);
        this._ensurePanel();
        this._addFrameEntry(frameData);
        this.selectFrame(id);
        this.sceneManager.redraw();
    }

    /**
     * Copy a joint's rotation axis
     */
    copyJointAxis(linkName, model) {
        if (!model || !model.joints) return;

        // Find the joint whose child is this link
        let targetJoint = null;
        let targetJointName = null;
        for (const [jName, joint] of model.joints) {
            if (joint.child === linkName &&
                (joint.type === 'revolute' || joint.type === 'continuous')) {
                targetJoint = joint;
                targetJointName = jName;
                break;
            }
        }
        if (!targetJoint || !targetJoint.threeObject) return;

        // Get world transform
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        targetJoint.threeObject.getWorldPosition(worldPos);
        targetJoint.threeObject.getWorldQuaternion(worldQuat);

        // Get local axis direction
        let localAxisDir = new THREE.Vector3(0, 0, 1);
        if (targetJoint.threeObject.axis) {
            localAxisDir.copy(targetJoint.threeObject.axis).normalize();
        } else if (targetJoint.axis && targetJoint.axis.xyz) {
            localAxisDir.set(
                targetJoint.axis.xyz[0] || 0,
                targetJoint.axis.xyz[1] || 0,
                targetJoint.axis.xyz[2] !== undefined ? targetJoint.axis.xyz[2] : 1
            ).normalize();
        }

        // Create geometry using static factory
        const group = CoordinateAxesManager.createJointArrowGeometry(localAxisDir);
        this._applyPastelColorsJointAxis(group);
        this._markAsCopiedFrame(group);

        // Position in world space (apply joint's world orientation)
        group.position.copy(worldPos);
        group.quaternion.copy(worldQuat);

        const id = `copy_axis_${this._nextId++}`;
        const label = `${targetJointName}`;

        // Set id on group for click-selection
        group.userData.copiedFrameId = id;

        this.sceneManager.scene.add(group);

        const frameData = {
            id,
            type: 'jointAxis',
            sourceLinkName: linkName,
            sourceJointName: targetJointName,
            label,
            originalWorldPosition: worldPos.clone(),
            originalWorldQuaternion: worldQuat.clone(),
            threeObject: group,
            translationOffset: new THREE.Vector3(),
            rotationOffset: new THREE.Euler(0, 0, 0, 'XYZ'),
            panelEntry: null
        };

        this.copiedFrames.set(id, frameData);
        this._ensurePanel();
        this._addFrameEntry(frameData);
        this.selectFrame(id);
        this.sceneManager.redraw();
    }

    /**
     * Delete a copied frame
     */
    deleteCopiedFrame(frameId) {
        const frame = this.copiedFrames.get(frameId);
        if (!frame) return;

        if (this.selectedFrameId === frameId) {
            this.deselectFrame();
        }

        this.sceneManager.scene.remove(frame.threeObject);
        frame.threeObject.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    child.material.dispose();
                }
            }
        });

        if (frame.panelEntry && frame.panelEntry.parentNode) {
            frame.panelEntry.parentNode.removeChild(frame.panelEntry);
        }

        this.copiedFrames.delete(frameId);

        if (this.copiedFrames.size === 0) {
            this._hidePanel();
        }

        this.sceneManager.redraw();
    }

    /**
     * Clear all copied frames
     */
    clearAll() {
        this.deselectFrame();
        for (const [id, frame] of this.copiedFrames) {
            this.sceneManager.scene.remove(frame.threeObject);
            frame.threeObject.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            });
        }
        this.copiedFrames.clear();
        if (this._listEl) this._listEl.innerHTML = '';
        this._hidePanel();
        this._nextId = 0;
    }

    // ==================== TransformControls ====================

    _initTransformControls() {
        if (this.transformControls) return;

        this.transformControls = new TransformControls(
            this.sceneManager.camera,
            this.sceneManager.canvas
        );
        this.transformControls.setSize(0.6);

        this.transformControls.addEventListener('change', () => {
            this.sceneManager.redraw();
        });

        this.transformControls.addEventListener('dragging-changed', (event) => {
            this.sceneManager.controls.enabled = !event.value;
        });

        this.transformControls.addEventListener('objectChange', () => {
            if (this.selectedFrameId) {
                this._updatePanelFromGizmo(this.selectedFrameId);
            }
        });

        this.sceneManager.scene.add(this.transformControls);
    }

    selectFrame(frameId) {
        const frame = this.copiedFrames.get(frameId);
        if (!frame) return;

        this._initTransformControls();

        // Deselect previous
        if (this.selectedFrameId && this.selectedFrameId !== frameId) {
            const prev = this.copiedFrames.get(this.selectedFrameId);
            if (prev && prev.panelEntry) {
                prev.panelEntry.classList.remove('selected');
            }
        }

        this.transformControls.attach(frame.threeObject);
        this.transformControls.visible = !frame.gizmoHidden;
        this.transformControls.enabled = !frame.gizmoHidden;
        this.selectedFrameId = frameId;

        if (frame.panelEntry) {
            frame.panelEntry.classList.add('selected');
        }

        this.sceneManager.redraw();
    }

    deselectFrame() {
        if (this.transformControls) {
            this.transformControls.detach();
        }
        if (this.selectedFrameId) {
            const prev = this.copiedFrames.get(this.selectedFrameId);
            if (prev && prev.panelEntry) {
                prev.panelEntry.classList.remove('selected');
            }
        }
        this.selectedFrameId = null;
    }

    setTransformMode(mode) {
        if (this.transformControls) {
            this.transformControls.setMode(mode);
        }
        // Update mode button states
        if (this._panel) {
            this._panel.querySelectorAll('.copied-frame-mode-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }
    }

    // ==================== Panel UI ====================

    _ensurePanel() {
        if (this._panel) {
            this._showPanel();
            return;
        }
        this._createPanel();
    }

    _createPanel() {
        const panel = document.createElement('div');
        panel.id = 'floating-copied-frames-panel';

        const header = document.createElement('div');
        header.className = 'floating-panel-header';

        const title = document.createElement('span');
        title.setAttribute('data-i18n', 'copiedFrames');
        title.textContent = 'Copied Frames';

        const actions = document.createElement('div');
        actions.className = 'panel-header-actions';

        const translateBtn = document.createElement('button');
        translateBtn.className = 'copied-frame-mode-btn active';
        translateBtn.dataset.mode = 'translate';
        translateBtn.textContent = 'T';
        translateBtn.title = 'Translate';
        translateBtn.addEventListener('click', () => this.setTransformMode('translate'));

        const rotateBtn = document.createElement('button');
        rotateBtn.className = 'copied-frame-mode-btn';
        rotateBtn.dataset.mode = 'rotate';
        rotateBtn.textContent = 'R';
        rotateBtn.title = 'Rotate';
        rotateBtn.addEventListener('click', () => this.setTransformMode('rotate'));

        const closeBtn = document.createElement('button');
        closeBtn.className = 'panel-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', () => this._hidePanel());

        actions.appendChild(translateBtn);
        actions.appendChild(rotateBtn);
        actions.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(actions);

        const list = document.createElement('div');
        list.id = 'copied-frames-list';

        panel.appendChild(header);
        panel.appendChild(list);
        document.body.appendChild(panel);

        this._panel = panel;
        this._listEl = list;

        // Register with PanelManager for drag support
        if (this.sceneManager.panelManager) {
            this.sceneManager.panelManager.registerPanel('floating-copied-frames-panel');
        }

        // Apply i18n if available
        if (window.app && window.app.applyI18n) {
            window.app.applyI18n();
        }
    }

    _addFrameEntry(frameData) {
        const entry = document.createElement('div');
        entry.className = 'copied-frame-entry';
        entry.dataset.frameId = frameData.id;

        // Header row
        const headerRow = document.createElement('div');
        headerRow.className = 'copied-frame-header';

        const label = document.createElement('span');
        label.className = 'copied-frame-label';
        const typeIcon = frameData.type === 'frame' ? '\u2316 ' : '\u2B6E ';
        label.textContent = typeIcon + frameData.label;

        const headerActions = document.createElement('div');
        headerActions.style.cssText = 'display:flex;align-items:center;gap:2px;flex-shrink:0;';

        const hideBtn = document.createElement('button');
        hideBtn.className = 'copied-frame-hide-source';
        hideBtn.textContent = '\u{1F441}';
        hideBtn.title = 'Hide gizmo';
        hideBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            frameData.gizmoHidden = !frameData.gizmoHidden;
            hideBtn.classList.toggle('active', frameData.gizmoHidden);
            hideBtn.title = frameData.gizmoHidden ? 'Show gizmo' : 'Hide gizmo';
            if (this.transformControls && this.selectedFrameId === frameData.id) {
                this.transformControls.visible = !frameData.gizmoHidden;
                this.transformControls.enabled = !frameData.gizmoHidden;
            }
            this.sceneManager.redraw();
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'copied-frame-delete';
        deleteBtn.textContent = '\u2715';
        deleteBtn.title = 'Delete';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteCopiedFrame(frameData.id);
        });

        headerActions.appendChild(hideBtn);
        headerActions.appendChild(deleteBtn);
        headerRow.appendChild(label);
        headerRow.appendChild(headerActions);

        // Input rows
        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'copied-frame-inputs';

        // Translation row
        const transRow = this._createInputRow(frameData.id, 'trans', [
            { key: 'tx', label: 'X', cls: 'axis-x', step: '0.001', value: 0 },
            { key: 'ty', label: 'Y', cls: 'axis-y', step: '0.001', value: 0 },
            { key: 'tz', label: 'Z', cls: 'axis-z', step: '0.001', value: 0 },
        ], 'T');

        // Rotation row (degrees)
        const rotRow = this._createInputRow(frameData.id, 'rot', [
            { key: 'roll', label: 'R', cls: 'axis-r', step: '0.1', value: 0 },
            { key: 'pitch', label: 'P', cls: 'axis-p', step: '0.1', value: 0 },
            { key: 'yaw', label: 'Y', cls: 'axis-w', step: '0.1', value: 0 },
        ], 'R');

        inputsDiv.appendChild(transRow);
        inputsDiv.appendChild(rotRow);

        entry.appendChild(headerRow);
        entry.appendChild(inputsDiv);

        // Click to select
        entry.addEventListener('click', () => {
            this.selectFrame(frameData.id);
        });

        this._listEl.appendChild(entry);
        frameData.panelEntry = entry;
    }

    _createInputRow(frameId, groupName, fields, groupLabel) {
        const row = document.createElement('div');
        row.className = 'copied-frame-input-group';

        const glabel = document.createElement('span');
        glabel.className = 'copied-frame-input-group-label';
        glabel.textContent = groupLabel;
        row.appendChild(glabel);

        fields.forEach(field => {
            const pair = document.createElement('div');
            pair.className = 'copied-frame-input-pair';

            const lbl = document.createElement('label');
            lbl.className = field.cls;
            lbl.textContent = field.label;

            const input = document.createElement('input');
            input.type = 'number';
            input.step = field.step;
            input.value = field.value;
            input.dataset.frameId = frameId;
            input.dataset.axis = field.key;

            input.addEventListener('input', () => {
                this._updateGizmoFromPanel(frameId);
            });

            // Prevent click from bubbling to entry (which would re-select)
            input.addEventListener('click', (e) => e.stopPropagation());

            pair.appendChild(lbl);
            pair.appendChild(input);
            row.appendChild(pair);
        });

        return row;
    }

    _showPanel() {
        if (this._panel) {
            this._panel.style.display = '';
        }
        const btn = document.getElementById('toggle-copied-frames-panel');
        if (btn) btn.classList.add('active');
    }

    _hidePanel() {
        if (this._panel) {
            this._panel.style.display = 'none';
        }
        const btn = document.getElementById('toggle-copied-frames-panel');
        if (btn) btn.classList.remove('active');
    }

    // ==================== Panel <-> Gizmo Sync ====================

    _updatePanelFromGizmo(frameId) {
        const frame = this.copiedFrames.get(frameId);
        if (!frame || !frame.panelEntry) return;

        // Compute translation offset
        const transOffset = new THREE.Vector3().subVectors(
            frame.threeObject.position,
            frame.originalWorldPosition
        );

        // Compute rotation offset: relativeQuat = inverse(original) * current
        const invOrigQuat = frame.originalWorldQuaternion.clone().invert();
        const relativeQuat = invOrigQuat.multiply(frame.threeObject.quaternion.clone());
        const rotOffset = new THREE.Euler().setFromQuaternion(relativeQuat, 'XYZ');

        // Store offsets
        frame.translationOffset.copy(transOffset);
        frame.rotationOffset.copy(rotOffset);

        // Update inputs
        const inputs = frame.panelEntry.querySelectorAll('input[type="number"]');
        inputs.forEach(input => {
            const axis = input.dataset.axis;
            switch (axis) {
                case 'tx': input.value = this._round(transOffset.x, 4); break;
                case 'ty': input.value = this._round(transOffset.y, 4); break;
                case 'tz': input.value = this._round(transOffset.z, 4); break;
                case 'roll': input.value = this._round(THREE.MathUtils.radToDeg(rotOffset.x), 2); break;
                case 'pitch': input.value = this._round(THREE.MathUtils.radToDeg(rotOffset.y), 2); break;
                case 'yaw': input.value = this._round(THREE.MathUtils.radToDeg(rotOffset.z), 2); break;
            }
        });
    }

    _updateGizmoFromPanel(frameId) {
        const frame = this.copiedFrames.get(frameId);
        if (!frame || !frame.panelEntry) return;

        const inputs = frame.panelEntry.querySelectorAll('input[type="number"]');
        let tx = 0, ty = 0, tz = 0, roll = 0, pitch = 0, yaw = 0;

        inputs.forEach(input => {
            const val = parseFloat(input.value) || 0;
            switch (input.dataset.axis) {
                case 'tx': tx = val; break;
                case 'ty': ty = val; break;
                case 'tz': tz = val; break;
                case 'roll': roll = val; break;
                case 'pitch': pitch = val; break;
                case 'yaw': yaw = val; break;
            }
        });

        // Apply translation offset
        frame.threeObject.position.copy(frame.originalWorldPosition).add(
            new THREE.Vector3(tx, ty, tz)
        );

        // Apply rotation offset
        const rotEuler = new THREE.Euler(
            THREE.MathUtils.degToRad(roll),
            THREE.MathUtils.degToRad(pitch),
            THREE.MathUtils.degToRad(yaw),
            'XYZ'
        );
        const rotQuat = new THREE.Quaternion().setFromEuler(rotEuler);
        frame.threeObject.quaternion.copy(
            frame.originalWorldQuaternion.clone().multiply(rotQuat)
        );

        // Store offsets
        frame.translationOffset.set(tx, ty, tz);
        frame.rotationOffset.copy(rotEuler);

        this.sceneManager.redraw();
    }

    // ==================== Visual Helpers ====================

    _applyPastelColors(group) {
        const colorMap = {
            0xff0000: 0xff8888, // X red -> pastel red
            0x00ff00: 0x88ff88, // Y green -> pastel green
            0x0000ff: 0x8888ff, // Z blue -> pastel blue
        };
        group.traverse(child => {
            if (child.isMesh && child.material) {
                const hex = child.material.color.getHex();
                if (colorMap[hex] !== undefined) {
                    child.material = child.material.clone();
                    child.material.color.setHex(colorMap[hex]);
                    child.material.transparent = true;
                    child.material.opacity = 0.85;
                    child.material.depthTest = true;
                }
            }
        });
    }

    _applyPastelColorsJointAxis(group) {
        group.traverse(child => {
            if (child.isMesh && child.material) {
                child.material = child.material.clone();
                const hex = child.material.color.getHex();
                if (hex === 0xff0000) {
                    child.material.color.setHex(0xff8888); // pastel red
                } else if (hex === 0x00ff00) {
                    child.material.color.setHex(0x88ff88); // pastel green
                }
                child.material.transparent = true;
                child.material.opacity = 0.85;
            }
        });
    }

    _markAsCopiedFrame(group) {
        group.traverse(child => {
            child.userData.isCopiedFrame = true;
        });
    }

    _round(value, decimals) {
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    // ==================== Cleanup ====================

    dispose() {
        this.clearAll();
        if (this.transformControls) {
            this.sceneManager.scene.remove(this.transformControls);
            this.transformControls.dispose();
            this.transformControls = null;
        }
        if (this._panel && this._panel.parentNode) {
            this._panel.parentNode.removeChild(this._panel);
            this._panel = null;
            this._listEl = null;
        }
    }
}
