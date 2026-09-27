import * as THREE from 'three';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';

const POSITION_TOLERANCE = 1e-6;
const ORIENTATION_TOLERANCE = 0.001;

function rotationVector(quaternion) {
    const q = quaternion.clone().normalize();
    if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const sinHalf = Math.hypot(q.x, q.y, q.z);
    if (sinHalf < 1e-10) return new THREE.Vector3();
    const angle = 2 * Math.atan2(sinHalf, q.w);
    return new THREE.Vector3(q.x, q.y, q.z).multiplyScalar(angle / sinHalf);
}

function solveLinear(matrix, vector) {
    const n = vector.length;
    const a = matrix.map((row, i) => [...row, vector[i]]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
        }
        if (Math.abs(a[pivot][col]) < 1e-12) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        const scale = a[col][col];
        for (let k = col; k <= n; k++) a[col][k] /= scale;
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const factor = a[row][col];
            for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
        }
    }
    return a.map(row => row[n]);
}

/** Position IK, optionally keeping or targeting the end link's orientation. */
export class EndEffectorIK {
    constructor(model, { setJoint = null } = {}) {
        this.model = model;
        this.setJoint = setJoint || ((joint, value) => ModelLoaderFactory.setJointAngle(model, joint.name, value, true));
    }

    getChain(linkName) {
        const link = this.model?.links?.get(linkName);
        if (!link?.threeObject || !this.model?.threeObject) return [];
        const chain = [];
        let object = link.threeObject.parent;
        while (object && object !== this.model.threeObject) {
            const joint = this.model.joints?.get(object.name);
            if (joint?.threeObject === object && joint.type !== 'fixed') {
                if (!['revolute', 'continuous', 'prismatic'].includes(joint.type) || object.mimicJoint) return [];
                chain.push(joint);
            }
            object = object.parent;
        }
        if (object !== this.model.threeObject) return [];
        return chain.reverse();
    }

    readPose(link) {
        this.model.threeObject.updateWorldMatrix(true, true);
        return {
            position: link.threeObject.getWorldPosition(new THREE.Vector3()),
            quaternion: link.threeObject.getWorldQuaternion(new THREE.Quaternion())
        };
    }

    write(joint, value) {
        this.setJoint(joint, value);
        joint.currentValue = value;
    }

    solve(linkName, targetPosition, targetQuaternion = null, {
        ignoreLimits = false, maxIterations = 32, jointWeights = null
    } = {}) {
        const link = this.model?.links?.get(linkName);
        const chain = this.getChain(linkName);
        if (!link || chain.length === 0 || this.model.constraints?.size) {
            return { supported: false, reason: 'No supported serial joint chain is available.' };
        }
        // Weights follow getChain() order: 0 is free, 1 is an exact lock.
        const weights = jointWeights ?? chain.map(() => 0);
        if (!Array.isArray(weights) || weights.length !== chain.length ||
            weights.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
            return { supported: false, reason: 'Invalid joint weight vector.' };
        }
        const activeIndices = chain.map((_, index) => index).filter(index => weights[index] < 1);
        const activeColumn = new Map(activeIndices.map((index, column) => [index, column]));
        const orientation = targetQuaternion instanceof THREE.Quaternion ? targetQuaternion.clone().normalize() : null;
        const original = chain.map(joint => joint.currentValue ?? 0);
        let values = original.slice();
        const weight = 0.2; // meters per radian, balances position and orientation errors
        const damping = 0.03;
        const sample = joint => joint.type === 'prismatic' ? 1e-5 : 1e-4;
        const limit = (joint, value) => {
            if (ignoreLimits || joint.type === 'continuous' || !joint.limits) return value;
            const low = Number.isFinite(joint.limits.lower) ? joint.limits.lower : -Infinity;
            const high = Number.isFinite(joint.limits.upper) ? joint.limits.upper : Infinity;
            return Math.max(low, Math.min(high, value));
        };
        const setValues = next => next.forEach((value, i) => this.write(chain[i], value));
        const errorAt = pose => {
            const position = targetPosition.clone().sub(pose.position);
            const rotation = orientation
                ? rotationVector(orientation.clone().multiply(pose.quaternion.clone().invert()))
                : new THREE.Vector3();
            const vector = [position.x, position.y, position.z];
            if (orientation) vector.push(rotation.x * weight, rotation.y * weight, rotation.z * weight);
            return { vector, position: position.length(), orientation: rotation.length(), cost: vector.reduce((sum, v) => sum + v * v, 0) };
        };

        let result;
        try {
            for (let iteration = 0; iteration < maxIterations; iteration++) {
                setValues(values);
                const base = this.readPose(link);
                const error = errorAt(base);
                if (error.position < POSITION_TOLERANCE && (!orientation || error.orientation < ORIENTATION_TOLERANCE)) break;
                if (activeIndices.length === 0) break;

                const columns = [];
                for (const i of activeIndices) {
                    const step = sample(chain[i]);
                    this.write(chain[i], values[i] + step);
                    const perturbed = this.readPose(link);
                    this.write(chain[i], values[i]);
                    const dp = perturbed.position.sub(base.position).divideScalar(step);
                    const column = [dp.x, dp.y, dp.z];
                    if (orientation) {
                        const dr = rotationVector(perturbed.quaternion.multiply(base.quaternion.clone().invert())).divideScalar(step);
                        column.push(dr.x * weight, dr.y * weight, dr.z * weight);
                    }
                    columns.push(column);
                }

                const matrix = columns.map((left, i) => columns.map((right, j) =>
                    left.reduce((sum, entry, k) => sum + entry * right[k], 0) +
                    (i === j ? damping * damping / (1 - weights[activeIndices[i]]) ** 2 : 0)));
                const rhs = columns.map(column => column.reduce((sum, entry, k) => sum + entry * error.vector[k], 0));
                const delta = solveLinear(matrix, rhs);
                if (!delta) break;

                let improved = false;
                for (const fraction of [1, 0.5, 0.25, 0.125]) {
                    const candidate = values.map((value, i) => {
                        const column = activeColumn.get(i);
                        if (column === undefined) return original[i];
                        const maxStep = chain[i].type === 'prismatic' ? 0.05 : 0.35;
                        return limit(chain[i], value + THREE.MathUtils.clamp(delta[column], -maxStep, maxStep) * fraction);
                    });
                    setValues(candidate);
                    if (errorAt(this.readPose(link)).cost < error.cost - 1e-18) {
                        values = candidate;
                        improved = true;
                        break;
                    }
                }
                if (!improved) break;
            }
            setValues(values);
            const pose = this.readPose(link);
            const error = errorAt(pose);
            result = {
                supported: true,
                values: Object.fromEntries(chain.map((joint, i) => [joint.name, values[i]])),
                positionError: error.position,
                orientationError: error.orientation,
                achievedPosition: pose.position.clone(),
                reached: error.position < POSITION_TOLERANCE && (!orientation || error.orientation < ORIENTATION_TOLERANCE)
            };
        } finally {
            setValues(original);
        }
        return result;
    }
}
