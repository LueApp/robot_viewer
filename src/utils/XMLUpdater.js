/**
 * XMLUpdater - XML update utility
 * Used for updating URDF/MJCF XML content
 */

export class XMLUpdater {
    static escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static formatVector(values) {
        if (!Array.isArray(values) || values.length !== 3 || values.some(value => !Number.isFinite(value))) {
            throw new Error('Expected a vector containing three finite numbers');
        }

        return values.map(value => {
            const normalized = Math.abs(value) < 1e-12 ? 0 : value;
            return Number(normalized.toPrecision(12)).toString();
        }).join(' ');
    }

    static maskComments(xmlContent) {
        return xmlContent.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length));
    }

    static findNamedBlock(xmlContent, tagName, name) {
        const searchableContent = this.maskComments(xmlContent);
        const escapedName = this.escapeRegExp(name);
        const openingTagRegex = new RegExp(
            `<${tagName}\\b(?=[^>]*\\bname\\s*=\\s*(["'])${escapedName}\\1)[^>]*>`,
            'i'
        );
        const openingMatch = openingTagRegex.exec(searchableContent);
        if (!openingMatch) return null;

        const closingTagRegex = new RegExp(`</${tagName}\\s*>`, 'i');
        const remainingContent = searchableContent.slice(openingMatch.index + openingMatch[0].length);
        const closingMatch = closingTagRegex.exec(remainingContent);
        if (!closingMatch) return null;

        const end = openingMatch.index + openingMatch[0].length + closingMatch.index + closingMatch[0].length;
        return {
            start: openingMatch.index,
            end,
            openingTag: xmlContent.slice(openingMatch.index, openingMatch.index + openingMatch[0].length),
            content: xmlContent.slice(openingMatch.index, end)
        };
    }

    static replaceBlock(xmlContent, block, updatedContent) {
        return xmlContent.slice(0, block.start) + updatedContent + xmlContent.slice(block.end);
    }

    static updateAttribute(openingTag, attributeName, value) {
        const attributeRegex = new RegExp(`\\b${attributeName}\\s*=\\s*(["'])[^"']*\\1`, 'i');
        if (attributeRegex.test(openingTag)) {
            return openingTag.replace(attributeRegex, `${attributeName}="${value}"`);
        }

        return openingTag.replace(/\s*\/?>$/, match => {
            const ending = match.includes('/') ? '/>' : '>';
            return ` ${attributeName}="${value}"${ending}`;
        });
    }

    static getChildIndent(blockContent) {
        const childIndentMatch = blockContent.match(/\n([ \t]+)<[\w:.-]+\b/);
        if (childIndentMatch) return childIndentMatch[1];

        const parentIndentMatch = blockContent.match(/^([ \t]*)</);
        return `${parentIndentMatch?.[1] || ''}  `;
    }

    static updateOriginInBlock(blockContent, origin) {
        const xyz = this.formatVector(origin.xyz);
        const rpy = this.formatVector(origin.rpy);
        const originRegex = /<origin\b[^>]*(?:\/\s*>|>[\s\S]*?<\/origin\s*>)/i;
        const originMatch = originRegex.exec(this.maskComments(blockContent));

        if (originMatch) {
            const originalOrigin = blockContent.slice(originMatch.index, originMatch.index + originMatch[0].length);
            const openingTagMatch = originalOrigin.match(/^<origin\b[^>]*>/i);
            if (!openingTagMatch) return blockContent;

            let updatedOpeningTag = this.updateAttribute(openingTagMatch[0], 'xyz', xyz);
            updatedOpeningTag = this.updateAttribute(updatedOpeningTag, 'rpy', rpy);
            const updatedOrigin = originalOrigin.replace(openingTagMatch[0], updatedOpeningTag);
            return blockContent.slice(0, originMatch.index)
                + updatedOrigin
                + blockContent.slice(originMatch.index + originalOrigin.length);
        }

        const openingEnd = blockContent.indexOf('>') + 1;
        const indent = this.getChildIndent(blockContent);
        const originTag = `\n${indent}<origin xyz="${xyz}" rpy="${rpy}"/>`;
        return blockContent.slice(0, openingEnd) + originTag + blockContent.slice(openingEnd);
    }

    static findGeometryElement(xmlContent, linkName, elementType, elementIndex) {
        if (!['visual', 'collision'].includes(elementType)) {
            throw new Error(`Unsupported URDF geometry element: ${elementType}`);
        }

        const linkBlock = this.findNamedBlock(xmlContent, 'link', linkName);
        if (!linkBlock) return null;

        const elementRegex = new RegExp(
            `<${elementType}\\b[^>]*(?:/\\s*>|>[\\s\\S]*?</${elementType}\\s*>)`,
            'gi'
        );
        const elements = Array.from(this.maskComments(linkBlock.content).matchAll(elementRegex));
        const elementMatch = elements[elementIndex];
        if (!elementMatch) return null;

        const relativeStart = elementMatch.index;
        return {
            linkBlock,
            relativeStart,
            element: linkBlock.content.slice(relativeStart, relativeStart + elementMatch[0].length)
        };
    }

    static replaceGeometryElement(xmlContent, selection, updatedElement) {
        const { linkBlock, relativeStart, element } = selection;
        const updatedLink = linkBlock.content.slice(0, relativeStart)
            + updatedElement
            + linkBlock.content.slice(relativeStart + element.length);
        return this.replaceBlock(xmlContent, linkBlock, updatedLink);
    }

    /**
     * Update the origin of an individual visual or collision element in a URDF link.
     * @param {string} xmlContent
     * @param {string} linkName
     * @param {'visual'|'collision'} elementType
     * @param {number} elementIndex Zero-based index within the link
     * @param {{xyz: number[], rpy: number[]}} origin
     * @returns {string}
     */
    static updateURDFGeometryOrigin(xmlContent, linkName, elementType, elementIndex, origin) {
        const selection = this.findGeometryElement(xmlContent, linkName, elementType, elementIndex);
        if (!selection) return xmlContent;

        const updatedElement = this.updateOriginInBlock(selection.element, origin);
        return this.replaceGeometryElement(xmlContent, selection, updatedElement);
    }

    /**
     * Update the scale of the mesh inside an individual visual or collision.
     * Negative components mirror the mesh on the corresponding local axes.
     */
    static updateURDFMeshScale(xmlContent, linkName, elementType, elementIndex, scale) {
        const selection = this.findGeometryElement(xmlContent, linkName, elementType, elementIndex);
        if (!selection) return xmlContent;

        const scaleValue = this.formatVector(scale);
        const meshRegex = /<mesh\b[^>]*(?:\/\s*>|>[\s\S]*?<\/mesh\s*>)/i;
        const meshMatch = meshRegex.exec(this.maskComments(selection.element));
        if (!meshMatch) return xmlContent;

        const originalMesh = selection.element.slice(meshMatch.index, meshMatch.index + meshMatch[0].length);
        const openingTagMatch = originalMesh.match(/^<mesh\b[^>]*>/i);
        if (!openingTagMatch) return xmlContent;

        const updatedOpeningTag = this.updateAttribute(openingTagMatch[0], 'scale', scaleValue);
        const updatedMesh = originalMesh.replace(openingTagMatch[0], updatedOpeningTag);
        const updatedElement = selection.element.slice(0, meshMatch.index)
            + updatedMesh
            + selection.element.slice(meshMatch.index + originalMesh.length);

        return this.replaceGeometryElement(xmlContent, selection, updatedElement);
    }

    /**
     * Update a URDF joint frame (the joint origin in its parent link).
     */
    static updateURDFJointOrigin(xmlContent, jointName, origin) {
        const jointBlock = this.findNamedBlock(xmlContent, 'joint', jointName);
        if (!jointBlock) return xmlContent;

        const updatedJoint = this.updateOriginInBlock(jointBlock.content, origin);
        return this.replaceBlock(xmlContent, jointBlock, updatedJoint);
    }

    /**
     * Update a URDF joint motion axis. The caller is responsible for normalization.
     */
    static updateURDFJointAxis(xmlContent, jointName, axis) {
        const jointBlock = this.findNamedBlock(xmlContent, 'joint', jointName);
        if (!jointBlock) return xmlContent;

        const xyz = this.formatVector(axis);
        const axisRegex = /<axis\b[^>]*(?:\/\s*>|>[\s\S]*?<\/axis\s*>)/i;
        const axisMatch = axisRegex.exec(this.maskComments(jointBlock.content));
        let updatedJoint = jointBlock.content;

        if (axisMatch) {
            const originalAxis = jointBlock.content.slice(axisMatch.index, axisMatch.index + axisMatch[0].length);
            const openingTagMatch = originalAxis.match(/^<axis\b[^>]*>/i);
            if (!openingTagMatch) return xmlContent;
            const updatedOpeningTag = this.updateAttribute(openingTagMatch[0], 'xyz', xyz);
            const updatedAxis = originalAxis.replace(openingTagMatch[0], updatedOpeningTag);
            updatedJoint = jointBlock.content.slice(0, axisMatch.index)
                + updatedAxis
                + jointBlock.content.slice(axisMatch.index + originalAxis.length);
        } else {
            const indent = this.getChildIndent(jointBlock.content);
            const axisTag = `${indent}<axis xyz="${xyz}"/>`;
            const laterChildRegex = /([ \t]*)<(?:calibration|dynamics|limit|mimic|safety_controller)\b/i;
            const laterChildMatch = laterChildRegex.exec(this.maskComments(jointBlock.content));

            if (laterChildMatch) {
                updatedJoint = jointBlock.content.slice(0, laterChildMatch.index)
                    + `${axisTag}\n`
                    + jointBlock.content.slice(laterChildMatch.index);
            } else {
                const closingIndex = jointBlock.content.search(/<\/joint\s*>/i);
                const beforeClosing = jointBlock.content.slice(0, closingIndex);
                const closingIndent = beforeClosing.match(/\n([ \t]*)$/)?.[1] || '';
                const prefix = beforeClosing.replace(/\s*$/, '');
                updatedJoint = `${prefix}\n${axisTag}\n${closingIndent}${jointBlock.content.slice(closingIndex)}`;
            }
        }

        return this.replaceBlock(xmlContent, jointBlock, updatedJoint);
    }

    /**
     * Reverse finite lower/upper limits after reversing a joint axis.
     * The equivalent range is lower' = -upper and upper' = -lower.
     */
    static reverseURDFJointLimits(xmlContent, jointName) {
        const jointBlock = this.findNamedBlock(xmlContent, 'joint', jointName);
        if (!jointBlock) return xmlContent;

        const limitRegex = /<limit\b[^>]*(?:\/\s*>|>[\s\S]*?<\/limit\s*>)/i;
        const limitMatch = limitRegex.exec(this.maskComments(jointBlock.content));
        if (!limitMatch) return xmlContent;

        const originalLimit = jointBlock.content.slice(
            limitMatch.index,
            limitMatch.index + limitMatch[0].length
        );
        const openingTagMatch = originalLimit.match(/^<limit\b[^>]*>/i);
        if (!openingTagMatch) return xmlContent;

        const openingTag = openingTagMatch[0];
        const readFiniteAttribute = attributeName => {
            const attributeRegex = new RegExp(
                `\\b${attributeName}\\s*=\\s*(["'])([^"']*)\\1`,
                'i'
            );
            const attributeMatch = attributeRegex.exec(openingTag);
            if (!attributeMatch || !attributeMatch[2].trim()) return null;
            const value = Number(attributeMatch[2]);
            return Number.isFinite(value) ? value : null;
        };

        const lower = readFiniteAttribute('lower');
        const upper = readFiniteAttribute('upper');
        if (lower === null || upper === null) return xmlContent;

        const formatLimit = value => {
            const normalized = Math.abs(value) < 1e-12 ? 0 : value;
            return Number(normalized.toPrecision(12)).toString();
        };
        let updatedOpeningTag = this.updateAttribute(openingTag, 'lower', formatLimit(-upper));
        updatedOpeningTag = this.updateAttribute(updatedOpeningTag, 'upper', formatLimit(-lower));
        const updatedLimit = originalLimit.replace(openingTag, updatedOpeningTag);
        const updatedJoint = jointBlock.content.slice(0, limitMatch.index)
            + updatedLimit
            + jointBlock.content.slice(limitMatch.index + originalLimit.length);

        return this.replaceBlock(xmlContent, jointBlock, updatedJoint);
    }

    /**
     * Update URDF joint limit attributes
     * @param {string} xmlContent - Original XML content
     * @param {string} jointName - Joint name
     * @param {Object} limits - New limit values { lower, upper, effort, velocity }
     * @returns {string} Updated XML content
     */
    static updateURDFJointLimits(xmlContent, jointName, limits) {
        try {
            // Use regex to find joint definition
            const jointRegex = new RegExp(
                `<joint[^>]*name="${jointName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</joint>`,
                'g'
            );

            const match = jointRegex.exec(xmlContent);
            if (!match) {
                console.warn(`Joint not found: ${jointName}`);
                return xmlContent;
            }

            const jointContent = match[0];
            let updatedJointContent = jointContent;

            // Find limit tag
            const limitRegex = /<limit([^>]*)>/;
            const limitMatch = limitRegex.exec(jointContent);

            if (limitMatch) {
                // Limit tag exists, update attributes
                let limitTag = limitMatch[0];
                const limitAttrs = limitMatch[1];

                // Update each attribute
                if (limits.lower !== undefined && limits.lower !== null) {
                    if (limitAttrs.includes('lower=')) {
                        limitTag = limitTag.replace(/lower="[^"]*"/, `lower="${limits.lower}"`);
                    } else {
                        limitTag = limitTag.replace(/>$/, ` lower="${limits.lower}">`);
                    }
                }

                if (limits.upper !== undefined && limits.upper !== null) {
                    if (limitAttrs.includes('upper=')) {
                        limitTag = limitTag.replace(/upper="[^"]*"/, `upper="${limits.upper}"`);
                    } else {
                        limitTag = limitTag.replace(/>$/, ` upper="${limits.upper}">`);
                    }
                }

                if (limits.effort !== undefined && limits.effort !== null) {
                    if (limitAttrs.includes('effort=')) {
                        limitTag = limitTag.replace(/effort="[^"]*"/, `effort="${limits.effort}"`);
                    } else {
                        limitTag = limitTag.replace(/>$/, ` effort="${limits.effort}">`);
                    }
                }

                if (limits.velocity !== undefined && limits.velocity !== null) {
                    if (limitAttrs.includes('velocity=')) {
                        limitTag = limitTag.replace(/velocity="[^"]*"/, `velocity="${limits.velocity}"`);
                    } else {
                        limitTag = limitTag.replace(/>$/, ` velocity="${limits.velocity}">`);
                    }
                }

                updatedJointContent = jointContent.replace(limitRegex, limitTag);
            } else {
                // No limit tag, create one
                const attrs = [];
                if (limits.lower !== undefined && limits.lower !== null) attrs.push(`lower="${limits.lower}"`);
                if (limits.upper !== undefined && limits.upper !== null) attrs.push(`upper="${limits.upper}"`);
                if (limits.effort !== undefined && limits.effort !== null) attrs.push(`effort="${limits.effort}"`);
                if (limits.velocity !== undefined && limits.velocity !== null) attrs.push(`velocity="${limits.velocity}"`);

                if (attrs.length > 0) {
                    const limitTag = `    <limit ${attrs.join(' ')}/>`;
                    // Insert before </joint>
                    updatedJointContent = jointContent.replace('</joint>', `${limitTag}\n  </joint>`);
                }
            }

            // Replace joint content in original XML
            return xmlContent.replace(jointContent, updatedJointContent);

        } catch (error) {
            console.error('Failed to update URDF joint limits:', error);
            return xmlContent;
        }
    }

    /**
     * Batch update multiple joint limits
     * @param {string} xmlContent - Original XML content
     * @param {Map} jointsLimits - Map<jointName, limits>
     * @returns {string} Updated XML content
     */
    static updateMultipleJointLimits(xmlContent, jointsLimits) {
        let updatedXML = xmlContent;

        for (let [jointName, limits] of jointsLimits.entries()) {
            updatedXML = this.updateURDFJointLimits(updatedXML, jointName, limits);
        }

        return updatedXML;
    }
}
