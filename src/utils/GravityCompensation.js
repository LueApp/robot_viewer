/**
 * GravityCompensation - Static gravity-compensation torque solver
 *
 * Computes, for the current pose, the torque (revolute/continuous) or force
 * (prismatic) each actuator must apply to HOLD the robot against gravity, i.e.
 * the "gravity compensation" term of the inverse dynamics with zero velocity
 * and acceleration:
 *
 *     tau_hold(j) = - axis_j . SUM_{i in subtree(j)} (p_com_i - p_joint_j) x (m_i * g)
 *
 * Everything is evaluated in the Three.js scene (world) frame. The SceneManager
 * wraps the robot in a `world` object that always rotates the user-selected
 * up-axis onto scene +Y, so gravity in the scene frame is constant: (0, -g, 0).
 * Because we read live `matrixWorld` transforms, the result automatically tracks
 * the displayed pose and the chosen up-axis.
 */

import * as THREE from 'three';
import { MathUtils } from './MathUtils.js';

const GRAVITY = 9.81; // m/s^2

export class GravityCompensation {
    /**
     * Compute gravity-compensation torques/forces for every non-fixed joint.
     *
     * @param {UnifiedRobotModel} model
     * @returns {{ joints: Map<string, {value:number, unit:string, type:string}>,
     *             totalMass: number, hasMass: boolean }}
     */
    static compute(model) {
        const result = { joints: new Map(), totalMass: 0, hasMass: false };
        if (!model || !model.joints || !model.threeObject) {
            return result;
        }

        // Ensure all world matrices reflect the current joint angles.
        model.threeObject.updateMatrixWorld(true);

        // Gravity force direction in the scene world frame is always straight down (-Y).
        const gravity = new THREE.Vector3(0, -GRAVITY, 0);

        // Precompute per-link mass and world-space center of mass.
        const linkInfo = new Map(); // linkName -> { mass, comWorld: THREE.Vector3 }
        model.links.forEach((link, name) => {
            const mass = link.inertial && link.inertial.mass ? link.inertial.mass : 0;
            if (mass <= 0) return;

            const obj = link.threeObject || this._findLinkObject(model.threeObject, name);
            if (!obj) return;

            const comLocal = link.inertial.origin && link.inertial.origin.xyz
                ? MathUtils.xyzToVector3(link.inertial.origin.xyz)
                : new THREE.Vector3();
            const comWorld = comLocal.clone().applyMatrix4(obj.matrixWorld);

            linkInfo.set(name, { mass, comWorld });
            result.totalMass += mass;
        });
        result.hasMass = linkInfo.size > 0;

        // Adjacency: parent link name -> [child link names] (every joint, incl. fixed).
        const childrenOf = new Map();
        model.joints.forEach((joint) => {
            if (!joint.parent || !joint.child) return;
            if (!childrenOf.has(joint.parent)) childrenOf.set(joint.parent, []);
            childrenOf.get(joint.parent).push(joint.child);
        });

        // Memoized subtree (inclusive) of a link, following the kinematic tree.
        const subtreeCache = new Map();
        const collectSubtree = (linkName, guard) => {
            if (subtreeCache.has(linkName)) return subtreeCache.get(linkName);
            const acc = [linkName];
            // Guard against cyclic graphs (closed-loop / parallel mechanisms).
            if (guard.has(linkName)) return acc;
            guard.add(linkName);
            const kids = childrenOf.get(linkName) || [];
            for (const k of kids) acc.push(...collectSubtree(k, guard));
            subtreeCache.set(linkName, acc);
            return acc;
        };

        const reusableForce = new THREE.Vector3();
        const reusableR = new THREE.Vector3();
        const reusableMoment = new THREE.Vector3();
        const jointWorldPos = new THREE.Vector3();

        model.joints.forEach((joint, name) => {
            if (joint.type === 'fixed') return;
            const jointObj = joint.threeObject;
            if (!jointObj) return;

            // World-frame joint axis and origin (same recipe as JointDragControls).
            const axisLocal = this._getJointAxis(joint);
            const axisWorld = axisLocal.clone().transformDirection(jointObj.matrixWorld).normalize();
            jointObj.getWorldPosition(jointWorldPos);

            const isPrismatic = joint.type === 'prismatic';
            const subtree = collectSubtree(joint.child, new Set());

            let gravityGeneralized = 0; // torque [N·m] for revolute, force [N] for prismatic
            for (const linkName of subtree) {
                const info = linkInfo.get(linkName);
                if (!info) continue;

                reusableForce.copy(gravity).multiplyScalar(info.mass); // m_i * g (world)
                if (isPrismatic) {
                    // Generalized force along the slide axis.
                    gravityGeneralized += axisWorld.dot(reusableForce);
                } else {
                    // Moment of the gravity force about the joint axis.
                    reusableR.subVectors(info.comWorld, jointWorldPos);
                    reusableMoment.crossVectors(reusableR, reusableForce);
                    gravityGeneralized += axisWorld.dot(reusableMoment);
                }
            }

            // Compensation = torque the actuator must apply to hold the pose.
            result.joints.set(name, {
                value: -gravityGeneralized,
                unit: isPrismatic ? 'N' : 'N·m',
                type: joint.type
            });
        });

        return result;
    }

    /** Joint axis in the joint's local frame (prefers the urdf-loader axis). */
    static _getJointAxis(joint) {
        if (joint.threeObject && joint.threeObject.axis instanceof THREE.Vector3) {
            return joint.threeObject.axis.clone();
        }
        if (joint.axis && joint.axis.xyz) {
            return MathUtils.xyzToVector3(joint.axis.xyz);
        }
        return new THREE.Vector3(0, 0, 1);
    }

    /** Fallback link lookup when link.threeObject is absent. */
    static _findLinkObject(root, linkName) {
        let found = null;
        root.traverse((child) => {
            if (!found && (child.name === linkName ||
                child.name === `link_${linkName}` ||
                child.name === `body_${linkName}`)) {
                found = child;
            }
        });
        return found;
    }
}
