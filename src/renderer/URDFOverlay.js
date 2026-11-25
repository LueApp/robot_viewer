import * as THREE from 'three';

export function isPoseJoint(joint) {
    return ['revolute', 'continuous', 'prismatic'].includes(joint?.type);
}

export function canLinkJoints(a, b) {
    return isPoseJoint(a) && isPoseJoint(b) && !a.threeObject.mimicJoint && !b.threeObject.mimicJoint
        && (a.type === 'prismatic') === (b.type === 'prismatic');
}

export class URDFOverlay {
    constructor(model) {
        this.model = model;
        this.root = model.threeObject;
        this.ghost = new THREE.MeshPhongMaterial({
            color: 0x36a8c2, shininess: 28, transparent: true, opacity: 0.45,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
        });
        this.originalMaterials = new Map();
        this.root.traverse(object => {
            if (!object.isMesh) return;
            this.originalMaterials.set(object, object.material);
        });
    }

    setView(mode, opacity) {
        this.ghost.opacity = opacity;
        if (this.mode === mode) return;
        this.mode = mode;
        const solid = mode === 'wipe';
        for (const [mesh, original] of this.originalMaterials) {
            mesh.material = solid ? original : this.ghost;
            mesh.renderOrder = solid ? 0 : 1;
            mesh.castShadow = solid;
            mesh.receiveShadow = solid;
        }
    }

    setJoint(name, value) {
        const joint = this.model.joints.get(name);
        if (!isPoseJoint(joint) || joint.threeObject.mimicJoint || !Number.isFinite(value)) return;
        joint.threeObject.setJointValue(value);
        joint.currentValue = joint.threeObject.angle;
        return joint.currentValue;
    }

    syncJoint(primaryJoint) {
        const reference = this.model.joints.get(primaryJoint.name);
        if (canLinkJoints(primaryJoint, reference)) {
            this.setJoint(reference.name, primaryJoint.threeObject.angle);
        }
    }

    dispose() {
        this.root.removeFromParent();
        const geometries = new Set();
        const materials = new Set([this.ghost]);
        const textures = new Set();
        for (const [mesh, original] of this.originalMaterials) {
            geometries.add(mesh.geometry);
            for (const material of [].concat(original)) {
                if (material) materials.add(material);
            }
        }
        for (const material of materials) {
            for (const property of Object.values(material)) {
                if (property?.isTexture) textures.add(property);
            }
            material.dispose();
        }
        for (const texture of textures) texture.dispose();
        for (const geometry of geometries) geometry.dispose();
        this.originalMaterials.clear();
    }
}
