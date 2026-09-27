import * as THREE from 'three';
import { findParentLink } from '../utils/JointDragControls.js';
import { EndEffectorIK } from '../utils/EndEffectorIK.js';
import './end-move.css';

const AXES = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1)
};
const COLORS = { x: 0xff5c5c, y: 0x68d679, z: 0x709aff, custom: 0xffbb55 };

export class EndMoveControls {
    constructor(sceneManager, poseController) {
        this.sceneManager = sceneManager;
        this.poseController = poseController;
        this.canvas = sceneManager.canvas;
        this.model = null;
        this.ik = null;
        this.linkName = null;
        this.holdWeights = new Map();
        this.axis = 'x';
        this.active = false;
        this.drag = null;
        this.pendingFrame = null;
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.panel = document.getElementById('end-move-controls');
        this.toggle = document.getElementById('toggle-end-move');
        this.linkSelect = document.getElementById('end-move-link');
        this.frameSelect = document.getElementById('end-move-frame');
        this.ikSelect = document.getElementById('end-move-ik');
        this.distanceInput = document.getElementById('end-move-distance');
        this.stepInput = document.getElementById('end-move-step');
        this.status = document.getElementById('end-move-status');
        this.weightList = document.getElementById('end-move-weight-list');
        this.vectorInputs = ['x', 'y', 'z'].map(axis => document.getElementById(`end-move-vector-${axis}`));
        this.gizmo = new THREE.Group();
        this.gizmo.visible = false;
        this.sceneManager.scene.add(this.gizmo);
        this.handles = {};
        this.makeHandles();
        this.canvas.tabIndex = 0;
        this.bindEvents();
        this.setAxis('x');
        this.poseController.subscribe(event => {
            if (event.type === 'jointChanged' || event.type === 'poseChanged') this.updateGizmo();
        });
        this.sceneManager.endMoveControls = this;
        this.syncLock();
    }

    makeHandles() {
        for (const axis of ['x', 'y', 'z', 'custom']) {
            const handle = new THREE.Group();
            handle.userData.endAxis = axis;
            const material = new THREE.MeshBasicMaterial({ color: COLORS[axis], depthTest: false });
            const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.6, 10), material);
            shaft.position.y = 0.4;
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.18, 12), material);
            tip.position.y = 0.79;
            handle.add(shaft, tip);
            handle.renderOrder = 100;
            this.gizmo.add(handle);
            this.handles[axis] = handle;
        }
    }

    bindEvents() {
        this.toggle?.addEventListener('click', () => this.setActive(!this.active));
        this.linkSelect?.addEventListener('change', () => this.selectLink(this.linkSelect.value));
        this.frameSelect?.addEventListener('change', () => this.updateGizmo());
        this.ikSelect?.addEventListener('change', () => this.report(''));
        document.querySelectorAll('[data-end-axis]').forEach(button => {
            button.addEventListener('click', () => this.setAxis(button.dataset.endAxis));
        });
        this.vectorInputs.forEach(input => input?.addEventListener('input', () => this.updateGizmo()));
        document.getElementById('end-move-apply')?.addEventListener('click', () => {
            const millimeters = Number(this.distanceInput.value);
            if (!Number.isFinite(millimeters) || this.distanceInput.value.trim() === '') return this.reportKey('endBadDistance');
            this.moveBy(millimeters / 1000);
        });
        this.distanceInput?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                document.getElementById('end-move-apply')?.click();
                event.preventDefault();
            }
        });
        document.getElementById('end-move-minus')?.addEventListener('click', () => this.nudge(-1));
        document.getElementById('end-move-plus')?.addEventListener('click', () => this.nudge(1));
        document.getElementById('end-move-reset-weights')?.addEventListener('click', () => {
            this.holdWeights.clear();
            this.renderWeightControls();
        });

        this._pointerDown = event => this.onPointerDown(event);
        this._pointerMove = event => this.onPointerMove(event);
        this._pointerUp = event => this.onPointerUp(event);
        this._keyDown = event => this.onKeyDown(event);
        this.canvas.addEventListener('pointerdown', this._pointerDown, true);
        this.canvas.addEventListener('pointermove', this._pointerMove);
        this.canvas.addEventListener('pointerup', this._pointerUp);
        this.canvas.addEventListener('pointercancel', this._pointerUp);
        this.canvas.addEventListener('keydown', this._keyDown);
    }

    report(message) {
        if (this.status) this.status.textContent = message;
    }

    message(key, values = {}) {
        return (window.i18n?.t(key) || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
    }

    reportKey(key, values = {}) {
        this.report(this.message(key, values));
    }

    editable() {
        return !!this.model?.threeObject && !this.poseController.liveLocked &&
            !window.app?.mujocoSimulationManager?.isSimulationRunning();
    }

    syncLock() {
        if (this.sceneManager.dragControls) {
            this.sceneManager.dragControls.enabled = !this.active && this.editable();
        }
        if (this.drag && !this.editable()) this.cancelDrag();
        this.updateGizmo();
    }

    setActive(active) {
        if (!active && this.drag?.changed && this.editable()) {
            this.poseController.commitJointValues(this.ik.getChain(this.linkName).map(joint => joint.name));
        }
        this.active = !!active;
        this.toggle?.classList.toggle('active', this.active);
        document.getElementById('floating-joints-panel')?.classList.toggle('end-move-active', this.active);
        if (this.panel) this.panel.hidden = !this.active;
        if (!this.active) this.cancelDrag();
        this.syncLock();
        if (this.active && !this.linkName) this.reportKey('endSelectPrompt');
    }

    setModel(model) {
        this.cancelDrag();
        this.model = model?.threeObject ? model : null;
        this.ik = this.model ? new EndEffectorIK(this.model) : null;
        this.holdWeights.clear();
        const box = this.model ? new THREE.Box3().setFromObject(this.model.threeObject) : null;
        this.gizmoScale = box ? Math.max(0.07, Math.min(0.5, box.getSize(new THREE.Vector3()).length() * 0.18)) : 0.1;
        this.linkName = null;
        this.weightList?.replaceChildren();
        if (this.linkSelect) {
            this.linkSelect.replaceChildren();
            if (this.model) {
                const children = new Set(Array.from(this.model.joints.values()).map(joint => joint.parent));
                const links = Array.from(this.model.links.values()).filter(link => link.threeObject);
                links.sort((a, b) => Number(children.has(a.name)) - Number(children.has(b.name)) || a.name.localeCompare(b.name));
                links.forEach(link => this.linkSelect.add(new Option(link.name, link.name)));
                const first = links.find(link => this.ik.getChain(link.name).length);
                if (first) this.selectLink(first.name);
            }
        }
        this.syncLock();
    }

    selectLink(name) {
        if (!name || !this.model?.links?.has(name)) return;
        if (!this.ik.getChain(name).length) {
            this.reportKey('endUnsupported');
            return;
        }
        this.linkName = name;
        if (this.linkSelect) this.linkSelect.value = name;
        this.renderWeightControls();
        this.reportKey('endSelected', { name });
        this.updateGizmo();
    }

    /** The displayed numeric fields form a vector in root-to-end chain order. */
    renderWeightControls() {
        if (!this.weightList) return;
        this.weightList.replaceChildren();
        if (!this.ik || !this.linkName) return;
        this.ik.getChain(this.linkName).forEach((joint, index) => {
            const row = document.createElement('div');
            row.className = 'end-move-weight-row';
            const label = document.createElement('label');
            label.htmlFor = `end-move-weight-${index}`;
            label.textContent = `${index + 1}. ${joint.name}`;
            label.title = joint.name;
            const input = document.createElement('input');
            input.id = label.htmlFor;
            input.type = 'number';
            input.min = '0';
            input.max = '100';
            input.step = '1';
            input.value = String(Math.round((this.holdWeights.get(joint.name) ?? 0) * 100));
            input.addEventListener('change', () => {
                const value = Number(input.value);
                if (input.value.trim() === '' || !Number.isFinite(value) || value < 0 || value > 100) {
                    input.value = String(Math.round((this.holdWeights.get(joint.name) ?? 0) * 100));
                    this.reportKey('endBadWeight');
                    return;
                }
                this.holdWeights.set(joint.name, value / 100);
            });
            const percent = document.createElement('span');
            percent.textContent = '%';
            row.append(label, input, percent);
            this.weightList.append(row);
        });
    }

    jointWeightVector() {
        return this.ik.getChain(this.linkName).map(joint => this.holdWeights.get(joint.name) ?? 0);
    }

    setAxis(axis) {
        if (!['x', 'y', 'z', 'custom'].includes(axis)) return;
        this.axis = axis;
        document.querySelectorAll('[data-end-axis]').forEach(button => {
            button.classList.toggle('active', button.dataset.endAxis === axis);
        });
        const vectorRow = document.getElementById('end-move-vector-row');
        if (vectorRow) vectorRow.hidden = axis !== 'custom';
        this.updateGizmo();
    }

    localDirection(axis = this.axis) {
        if (axis !== 'custom') return AXES[axis]?.clone() || null;
        const values = this.vectorInputs.map(input => Number(input?.value));
        if (values.some(value => !Number.isFinite(value))) return null;
        const direction = new THREE.Vector3(...values);
        return direction.lengthSq() > 1e-12 ? direction.normalize() : null;
    }

    worldDirection(axis = this.axis) {
        const local = this.localDirection(axis);
        if (!local || !this.linkName || !this.model) return null;
        const link = this.model.links.get(this.linkName);
        this.model.threeObject.updateWorldMatrix(true, true);
        const frame = this.frameSelect?.value === 'robot' ? this.model.threeObject : link.threeObject;
        return local.applyQuaternion(frame.getWorldQuaternion(new THREE.Quaternion())).normalize();
    }

    updateGizmo() {
        if (!this.gizmo) return;
        this.gizmo.visible = !!(this.active && this.editable() && this.linkName);
        if (!this.gizmo.visible) {
            this.sceneManager.redraw();
            return;
        }
        const link = this.model.links.get(this.linkName);
        if (!link?.threeObject) return;
        this.model.threeObject.updateWorldMatrix(true, true);
        this.gizmo.position.copy(link.threeObject.getWorldPosition(new THREE.Vector3()));
        const frame = this.frameSelect?.value === 'robot' ? this.model.threeObject : link.threeObject;
        this.gizmo.quaternion.copy(frame.getWorldQuaternion(new THREE.Quaternion()));
        this.gizmo.scale.setScalar(this.gizmoScale);
        for (const axis of ['x', 'y', 'z']) {
            this.handles[axis].visible = this.axis !== 'custom';
            this.handles[axis].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXES[axis]);
        }
        const custom = this.localDirection('custom');
        this.handles.custom.visible = this.axis === 'custom' && !!custom;
        if (custom) this.handles.custom.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), custom);
        this.sceneManager.redraw();
    }

    pointerRay(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.sceneManager.camera);
    }

    handleHit() {
        const hits = this.raycaster.intersectObject(this.gizmo, true);
        for (const hit of hits) {
            let object = hit.object;
            while (object && object !== this.gizmo) {
                if (object.userData.endAxis) return object.userData.endAxis;
                object = object.parent;
            }
        }
        return null;
    }

    linkHit() {
        const hits = this.raycaster.intersectObject(this.model.threeObject, true);
        for (const hit of hits) {
            if (!hit.object.isMesh || !hit.object.visible) continue;
            let object = hit.object;
            let collision = false;
            while (object && object !== this.model.threeObject) {
                if (object.isURDFCollider || object.userData?.isCollision || object.userData?.isCollisionGeom) collision = true;
                object = object.parent;
            }
            if (collision) continue;
            const link = findParentLink(hit.object, this.model);
            if (link) return link.name;
        }
        return null;
    }

    screenPoint(world) {
        const rect = this.canvas.getBoundingClientRect();
        const point = world.clone().project(this.sceneManager.camera);
        return new THREE.Vector2(rect.left + (point.x + 1) * rect.width / 2, rect.top + (1 - point.y) * rect.height / 2);
    }

    onPointerDown(event) {
        if (!this.active || !this.editable() || event.button !== 0) return;
        this.canvas.focus();
        this.pointerRay(event);
        const handle = this.gizmo.visible ? this.handleHit() : null;
        if (handle) {
            this.setAxis(handle);
            const link = this.model.links.get(this.linkName);
            const startPose = this.ik.readPose(link);
            const direction = this.worldDirection(handle);
            if (!direction) return this.reportKey('endBadDirection');
            const base = this.screenPoint(startPose.position);
            const projected = this.screenPoint(startPose.position.clone().add(direction));
            const pixelDirection = projected.sub(base);
            this.drag = {
                pointerId: event.pointerId,
                startPose,
                direction,
                startPixel: new THREE.Vector2(event.clientX, event.clientY),
                pixelDirection,
                lastEvent: event,
                changed: false
            };
            this.canvas.setPointerCapture(event.pointerId);
            this.sceneManager.controls.enabled = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const name = this.linkHit();
        if (name) {
            this.selectLink(name);
            event.preventDefault();
            event.stopPropagation();
        }
    }

    onPointerMove(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.drag.lastEvent = event;
        if (this.pendingFrame === null) {
            this.pendingFrame = requestAnimationFrame(() => {
                this.pendingFrame = null;
                this.applyDrag();
            });
        }
        event.preventDefault();
    }

    applyDrag() {
        if (!this.drag || !this.editable()) return;
        const { startPixel, pixelDirection, startPose, direction, lastEvent } = this.drag;
        if (this.drag.lastApplied?.x === lastEvent.clientX && this.drag.lastApplied?.y === lastEvent.clientY) return;
        this.drag.lastApplied = { x: lastEvent.clientX, y: lastEvent.clientY };
        const movement = new THREE.Vector2(lastEvent.clientX, lastEvent.clientY).sub(startPixel);
        let distance;
        if (pixelDirection.lengthSq() > 225) {
            distance = movement.dot(pixelDirection) / pixelDirection.lengthSq();
        } else {
            const camera = this.sceneManager.camera;
            const depth = camera.position.distanceTo(startPose.position);
            const height = this.canvas.getBoundingClientRect().height;
            distance = -movement.y * 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / height;
        }
        const result = this.applyTarget(startPose, direction, distance, false);
        if (result?.applied) this.drag.changed = true;
    }

    onPointerUp(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.drag.lastEvent = event;
        if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
        this.pendingFrame = null;
        this.applyDrag();
        const changed = this.drag.changed;
        this.cancelDrag();
        if (changed) this.poseController.commitJointValues(this.ik.getChain(this.linkName).map(joint => joint.name));
        event.preventDefault();
    }

    cancelDrag() {
        if (!this.drag) return;
        if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
        this.pendingFrame = null;
        if (this.canvas.hasPointerCapture(this.drag.pointerId)) this.canvas.releasePointerCapture(this.drag.pointerId);
        this.drag = null;
        this.sceneManager.controls.enabled = true;
    }

    applyTarget(startPose, direction, distance, commit) {
        if (!this.active || !this.editable() || !this.ik || !this.linkName) return null;
        const target = startPose.position.clone().addScaledVector(direction, distance);
        const orientation = this.ikSelect?.value === 'pose' ? startPose.quaternion : null;
        const result = this.ik.solve(this.linkName, target, orientation, {
            ignoreLimits: this.sceneManager.ignoreLimits,
            jointWeights: this.jointWeightVector()
        });
        if (!result.supported) {
            this.reportKey('endUnsupported');
            return result;
        }
        if (orientation && result.orientationError > 0.002) {
            this.reportKey('endOrientationError', { error: THREE.MathUtils.radToDeg(result.orientationError).toFixed(2) });
            return { ...result, applied: false };
        }
        const displacement = result.achievedPosition.clone().sub(startPose.position);
        const offAxis = displacement.clone().addScaledVector(direction, -displacement.dot(direction)).length();
        if (offAxis > 2e-6) {
            this.reportKey('endOffAxis', { error: (offAxis * 1000).toFixed(3) });
            return { ...result, applied: false };
        }
        const changed = Object.entries(result.values).some(([name, value]) =>
            Math.abs(value - (this.model.joints.get(name)?.currentValue ?? 0)) > 1e-9);
        if (!changed) {
            this.reportKey('endNoMovement', { error: (result.positionError * 1000).toFixed(2) });
            return { ...result, applied: false };
        }
        const applied = this.poseController.applyJointValues(result.values, { ignoreLimits: this.sceneManager.ignoreLimits });
        if (!applied) return null;
        if (commit) this.poseController.commitJointValues(Object.keys(applied));
        const orientationText = orientation ? this.message('endOrientationResult', {
            error: THREE.MathUtils.radToDeg(result.orientationError).toFixed(2)
        }) : '';
        this.report(this.message('endMoveResult', {
            distance: (distance * 1000).toFixed(2), error: (result.positionError * 1000).toFixed(2)
        }) + orientationText);
        return { ...result, applied: true };
    }

    moveBy(distance) {
        if (!Number.isFinite(distance) || !this.linkName || !this.ik) return;
        const direction = this.worldDirection();
        if (!direction) return this.reportKey('endBadDirection');
        const startPose = this.ik.readPose(this.model.links.get(this.linkName));
        this.applyTarget(startPose, direction, distance, true);
    }

    nudge(sign) {
        const step = Number(this.stepInput?.value);
        if (!(step >= 0.01) || !Number.isFinite(step)) return this.reportKey('endBadStep');
        this.moveBy(sign * step / 1000);
    }

    onKeyDown(event) {
        if (!this.active || !this.editable()) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const axis = event.key.toLowerCase();
        if (['x', 'y', 'z'].includes(axis)) {
            this.setAxis(axis);
            event.preventDefault();
        } else if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) {
            const step = Number(this.stepInput?.value);
            if (!(step >= 0.01) || !Number.isFinite(step)) return this.reportKey('endBadStep');
            const sign = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1;
            this.moveBy(sign * step * (event.shiftKey ? 10 : 1) / 1000);
            event.preventDefault();
        }
    }
}
