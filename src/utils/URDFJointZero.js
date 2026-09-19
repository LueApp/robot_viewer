import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { XMLUpdater } from './XMLUpdater.js';

const attribute = (tag, name) => tag?.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
const tagIn = (xml, name) => XMLUpdater.maskComments(xml).match(new RegExp(`<${name}\\b[^>]*>`))?.[0];

function numberAttribute(tag, name, fallback) {
    const text = attribute(tag, name);
    if (text === undefined) return fallback;
    const value = text.trim() ? Number(text) : NaN;
    if (!Number.isFinite(value)) throw new Error(`Invalid URDF ${name}: expected a finite number.`);
    return value;
}

function vectorAttribute(tag, name, fallback) {
    const text = attribute(tag, name);
    if (text === undefined) return fallback;
    const values = text.trim().split(/\s+/).map(Number);
    if (values.length !== 3 || !values.every(Number.isFinite)) {
        throw new Error(`Invalid URDF ${name}: expected three finite numbers.`);
    }
    return values;
}

function rewriteTag(xml, name, update) {
    const match = new RegExp(`<${name}\\b[^>]*>`).exec(XMLUpdater.maskComments(xml));
    if (!match) return xml;
    const original = xml.slice(match.index, match.index + match[0].length);
    return xml.slice(0, match.index) + update(original) + xml.slice(match.index + original.length);
}

function shiftAttributes(xml, tagName, names, offset) {
    return rewriteTag(xml, tagName, tag => names.reduce((updated, name) => {
        const value = numberAttribute(tag, name);
        if (value === undefined) return updated;
        const shifted = value - offset;
        if (!Number.isFinite(shifted)) throw new Error('The zero offset is too large.');
        return XMLUpdater.updateAttribute(updated, name, Number(shifted.toPrecision(15)).toString());
    }, tag));
}

function rotationToRPY(rotation) {
    const m = new Matrix4().makeRotationFromQuaternion(rotation).elements;
    const pitch = Math.atan2(-m[2], Math.hypot(m[0], m[1]));
    const yaw = Math.atan2(m[1], m[0]);
    // Remove yaw before extracting roll. This stays accurate near +/-90° pitch,
    // where Euler.setFromQuaternion intentionally snaps to a singular solution.
    const roll = Math.atan2(
        Math.sin(yaw) * m[8] - Math.cos(yaw) * m[9],
        Math.cos(yaw) * m[5] - Math.sin(yaw) * m[4]
    );
    return [roll, pitch, yaw];
}

/**
 * Define qNew = qOld - offset. Moving the joint origin by its own motion at
 * offset preserves T_old(q) = T_new(q - offset), including the entire subtree.
 * URDF fixed-axis RPY is represented by Three.js's ZYX Euler order.
 */
export function rebaseURDFJoint(xml, jointName, offset) {
    if (!Number.isFinite(offset)) throw new Error('Enter a finite zero position.');
    const block = XMLUpdater.findNamedBlock(xml, 'joint', jointName);
    if (!block) throw new Error('The selected joint was not found in the URDF.');
    const type = attribute(block.openingTag, 'type');
    if (!['revolute', 'continuous', 'prismatic'].includes(type)) {
        throw new Error('Zero adjustment requires a revolute, continuous, or prismatic joint.');
    }
    if (tagIn(block.content, 'mimic')) {
        throw new Error('This joint mimics another joint. Adjust the driving joint’s zero instead.');
    }

    const origin = tagIn(block.content, 'origin');
    const xyz = new Vector3(...vectorAttribute(origin, 'xyz', [0, 0, 0]));
    const rpy = vectorAttribute(origin, 'rpy', [0, 0, 0]);
    const rotation = new Quaternion().setFromEuler(new Euler(...rpy, 'ZYX'));
    const axis = new Vector3(...vectorAttribute(tagIn(block.content, 'axis'), 'xyz', [1, 0, 0]));
    if (axis.length() < 1e-9) throw new Error('The joint axis cannot be a zero vector.');
    axis.normalize();

    if (type === 'prismatic') {
        xyz.addScaledVector(axis.applyQuaternion(rotation), offset);
    } else {
        rotation.multiply(new Quaternion().setFromAxisAngle(axis, offset));
    }
    let updated = XMLUpdater.updateOriginInBlock(block.content, {
        xyz: xyz.toArray(),
        rpy: type === 'prismatic' ? rpy : rotationToRPY(rotation)
    });
    // Continuous joints have no positional bounds; keep effort/velocity intact.
    if (type !== 'continuous') {
        updated = shiftAttributes(updated, 'limit', ['lower', 'upper'], offset);
        updated = shiftAttributes(updated, 'safety_controller', ['soft_lower_limit', 'soft_upper_limit'], offset);
    }
    updated = shiftAttributes(updated, 'calibration', ['rising', 'falling'], offset);
    let result = XMLUpdater.replaceBlock(xml, block, updated);

    // A follower must keep its physical position: m*qOld + b = m*qNew + (b+m*offset).
    const jointTags = [...XMLUpdater.maskComments(result).matchAll(/<joint\b[^>]*>/g)];
    for (const [tag] of jointTags) {
        const name = attribute(tag, 'name');
        if (!name || name === jointName) continue;
        const follower = XMLUpdater.findNamedBlock(result, 'joint', name);
        if (!follower) continue;
        const mimic = tagIn(follower.content, 'mimic');
        if (attribute(mimic, 'joint') !== jointName) continue;
        const newOffset = numberAttribute(mimic, 'offset', 0)
            + numberAttribute(mimic, 'multiplier', 1) * offset;
        if (!Number.isFinite(newOffset)) throw new Error('The mimic offset is too large.');
        const content = rewriteTag(follower.content, 'mimic', original =>
            XMLUpdater.updateAttribute(original, 'offset', Number(newOffset.toPrecision(15)).toString()));
        result = XMLUpdater.replaceBlock(result, follower, content);
    }
    return result;
}
