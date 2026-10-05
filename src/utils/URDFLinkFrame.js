import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { XMLUpdater } from './XMLUpdater.js';

export const URDF_LINK_FRAME_MARKER = 'robot-viewer: link-frame-adjustment';

export function isURDFLinkFrameJoint(joint) {
    return joint?.type === 'fixed'
        && Array.from(joint.threeObject?.urdfNode?.childNodes || []).some(node =>
            node.nodeType === 8 && node.nodeValue?.trim() === URDF_LINK_FRAME_MARKER);
}

const decodeAttribute = value => value?.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.startsWith('#')) {
        return String.fromCodePoint(entity[1].toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
});
const attribute = (tag, name) => decodeAttribute(tag?.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2]);

// Track depth so transmission joints and extension tags are never mistaken for
// robot joints. Keep source ranges to preserve formatting and unrelated XML.
function elements(xml) {
    const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const result = [];
    const stack = [];
    let current;
    for (const match of xml.matchAll(tokens)) {
        const tag = match[0];
        if (/^<[!?]/.test(tag)) continue;
        const name = tag.match(/^<\/?([\w:.-]+)/)[1];
        if (tag.startsWith('</')) {
            if (stack.pop() !== name) throw new Error('Invalid URDF XML structure.');
            if (stack.length === 0) {
                current.end = match.index + tag.length;
                current.content = xml.slice(current.start, current.end);
                result.push(current);
            }
        } else {
            if (stack.length === 0) current = { name, start: match.index, openingTag: tag };
            if (/\/\s*>$/.test(tag)) {
                if (stack.length === 0) result.push({ ...current, end: match.index + tag.length, content: tag });
            } else {
                stack.push(name);
            }
        }
    }
    if (stack.length) throw new Error('Invalid URDF XML structure.');
    return result;
}

function children(block) {
    if (/\/\s*>$/.test(block.openingTag)) return [];
    const offset = block.openingTag.length;
    return elements(block.content.slice(offset, block.content.lastIndexOf('</')))
        .map(child => ({ ...child, start: child.start + offset, end: child.end + offset }));
}

function vector(text, fallback) {
    if (text === undefined) return fallback;
    const values = text.trim().split(/\s+/).map(Number);
    if (!text.trim() || values.length !== 3 || !values.every(Number.isFinite)) {
        throw new Error('A frame transform must contain three finite XYZ and RPY values.');
    }
    return values;
}

function matrixFromOrigin(origin) {
    XMLUpdater.formatVector(origin.xyz);
    XMLUpdater.formatVector(origin.rpy);
    return new Matrix4().compose(new Vector3(...origin.xyz),
        new Quaternion().setFromEuler(new Euler(...origin.rpy, 'ZYX')), new Vector3(1, 1, 1));
}

function readTransform(block) {
    const tag = children(block).find(child => child.name === 'origin')?.openingTag;
    return matrixFromOrigin({
        xyz: vector(attribute(tag, 'xyz'), [0, 0, 0]),
        rpy: vector(attribute(tag, 'rpy'), [0, 0, 0])
    });
}

function originFromMatrix(matrix) {
    const m = matrix.elements;
    const yaw = Math.atan2(m[1], m[0]);
    return {
        xyz: [m[12], m[13], m[14]],
        rpy: [
            Math.atan2(Math.sin(yaw) * m[8] - Math.cos(yaw) * m[9],
                Math.cos(yaw) * m[5] - Math.sin(yaw) * m[4]),
            Math.atan2(-m[2], Math.hypot(m[0], m[1])),
            yaw
        ]
    };
}

function graph(xml) {
    const robot = elements(xml).find(block => block.name === 'robot');
    if (!robot) throw new Error('The editor does not contain a URDF robot.');
    const blocks = children(robot);
    return { robot, links: blocks.filter(block => block.name === 'link'), joints: blocks.filter(block => block.name === 'joint') };
}

const nameOf = block => attribute(block.openingTag, 'name');
const linkOf = (joint, tag) => attribute(children(joint).find(child => child.name === tag)?.openingTag, 'link');

function replaceChildren(xml, robot, replacements) {
    let content = robot.content;
    for (const { block, content: replacement } of replacements.sort((a, b) => b.block.start - a.block.start)) {
        content = XMLUpdater.replaceBlock(content, block, replacement);
    }
    return XMLUpdater.replaceBlock(xml, robot, content);
}

function transformedContents(link, joints, transform) {
    let content = link.content;
    for (const child of children(link).reverse()) {
        if (!['visual', 'collision', 'inertial'].includes(child.name)) continue;
        content = XMLUpdater.replaceBlock(content, child, XMLUpdater.updateOriginInBlock(child.content,
            originFromMatrix(transform.clone().multiply(readTransform(child)))));
    }
    return [
        { block: link, content },
        ...joints.filter(joint => linkOf(joint, 'parent') === nameOf(link)).map(joint => ({
            block: joint,
            content: XMLUpdater.updateOriginInBlock(joint.content,
                originFromMatrix(transform.clone().multiply(readTransform(joint))))
        }))
    ];
}

function readAxis(joint) {
    const tag = children(joint).find(child => child.name === 'axis')?.openingTag;
    const axis = new Vector3(...vector(attribute(tag, 'xyz'), [1, 0, 0]));
    if (axis.length() < 1e-9) throw new Error(`Joint "${nameOf(joint)}" has a zero motion axis.`);
    return axis.normalize();
}

function updateAxis(content, axis) {
    const block = elements(content)[0];
    const nodes = children(block);
    const existing = nodes.find(child => child.name === 'axis');
    const xyz = XMLUpdater.formatVector(axis.toArray());
    if (existing) {
        return XMLUpdater.replaceBlock(content, existing,
            existing.content.replace(existing.openingTag, XMLUpdater.updateAttribute(existing.openingTag, 'xyz', xyz)));
    }
    const afterChild = nodes.find(child => child.name === 'child')?.end;
    if (afterChild === undefined) throw new Error(`Joint "${nameOf(block)}" has no child link.`);
    return content.slice(0, afterChild) + `\n${XMLUpdater.getChildIndent(content)}<axis xyz="${xyz}"/>` + content.slice(afterChild);
}

function reframeJoint(joint, delta) {
    const type = attribute(joint.openingTag, 'type');
    if (!['fixed', 'revolute', 'continuous', 'prismatic'].includes(type)) {
        throw new Error(`Direct frame adjustment does not support "${type}" joint "${nameOf(joint)}".`);
    }
    const axis = type === 'fixed' ? null : readAxis(joint);
    if (['revolute', 'continuous'].includes(type)) {
        const translation = new Vector3().setFromMatrixPosition(delta);
        const projected = axis.clone().multiplyScalar(translation.dot(axis));
        if (translation.distanceTo(projected) > 1e-10 * Math.max(1, translation.length())) {
            throw new Error(`Joint "${nameOf(joint)}": the frame translation must lie on its rotation axis. `
                + 'An off-axis frame cannot preserve revolute motion without an extra joint.');
        }
    }
    let content = XMLUpdater.updateOriginInBlock(joint.content,
        originFromMatrix(readTransform(joint).multiply(delta)));
    if (axis) content = updateAxis(content, axis.transformDirection(delta.clone().invert()));
    return content;
}

/**
 * Move a link coordinate frame by a transform expressed in its CURRENT frame.
 * If W is the old link transform and D the adjustment, the new frame is W*D.
 * Its geometry/inertia and outgoing joints become D^-1*T, so their world
 * transforms are unchanged for every pose, including mimic motion.
 * The incoming joint becomes O*D, with axis R_D^T*a. For revolute motion,
 * D's translation must lie on the original rotation axis, because URDF's
 * joint frame is also the child link frame. No links or joints are added.
 */
export function adjustURDFLinkFrame(xml, linkName, adjustment) {
    const delta = matrixFromOrigin(adjustment);
    const { robot, links, joints } = graph(xml);
    const link = links.find(block => nameOf(block) === linkName);
    if (!link) throw new Error('The selected link was not found in the URDF.');

    const incoming = joints.filter(joint => linkOf(joint, 'child') === linkName);
    if (incoming.length > 1) throw new Error('Frame adjustment requires a link with at most one parent joint.');
    if (adjustment.xyz.every(value => value === 0) && adjustment.rpy.every(value => value === 0)) return xml;

    const parentJoint = incoming[0];
    if (!parentJoint) {
        throw new Error('A root link has no joint origin to update. Its frame must be set by an external base pose.');
    }
    const replacements = transformedContents(link, joints, delta.clone().invert());
    replacements.push({ block: parentJoint, content: reframeJoint(parentJoint, delta) });
    return replaceChildren(xml, robot, replacements);
}
