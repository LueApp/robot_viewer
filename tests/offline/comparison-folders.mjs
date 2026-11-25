import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkComparisonFolders({ call, evaluate, until, temporary }) {
    // Both directory pickers will return identical webkitRelativePath values.
    const folder = version => path.join(temporary, version, 'robot');
    for (const [version, width] of [['original', 2], ['reference', 5], ['replacement', 7]]) {
        const dir = folder(version);
        await fs.mkdir(path.join(dir, 'meshes'), { recursive: true });
        const xml = `<robot name="${version}"><link name="base"><visual name="body"><geometry><mesh filename="meshes/body.obj"/></geometry></visual></link></robot>`;
        await fs.writeFile(path.join(dir, 'robot.urdf'), xml);
        await fs.writeFile(path.join(dir, 'meshes/body.obj'), `v 0 0 0\nv ${width} 0 0\nv 0 1 0\nf 1 2 3\n`);
        if (version === 'original') await fs.writeFile(path.join(dir, 'other.urdf'), xml.replace('original', 'other'));
    }
    await fs.mkdir(folder('invalid'), { recursive: true });
    await fs.writeFile(path.join(folder('invalid'), 'robot.urdf'), '<invalid/>');
    await fs.mkdir(folder('pointer'), { recursive: true });
    await fs.writeFile(path.join(folder('pointer'), 'robot.urdf'),
        '<robot name="pointer"><link name="base"><visual><geometry><mesh filename="body.STL"/></geometry></visual></link></robot>');
    await fs.writeFile(path.join(folder('pointer'), 'body.STL'),
        'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 7038484\n');

    await call('Page.setInterceptFileChooserDialog', { enabled: true });
    await evaluate('document.querySelector("#urdf-comparison summary").click()');
    assert.equal(await evaluate(`['[data-open-primary-folder]', '[data-open-folder]'].every(selector =>
        document.querySelector(selector).getBoundingClientRect().height > 0)`), true);
    const { root } = await call('DOM.getDocument');
    const pick = async (side, version) => {
        const button = side === 'primary' ? '[data-open-primary-folder]' : '[data-open-folder]';
        await evaluate(`document.querySelector('${button}').click()`);
        const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-${side}-folder]` });
        await call('DOM.setFileInputFiles', { nodeId, files: [folder(version)] });
    };
    const width = "visual.body.children[0]?.children[0]?.geometry.attributes.position.getX(1)";
    const waitForWidths = (primary, reference) => until(() => evaluate(
        `app.currentModel?.threeObject.${width} === ${primary} && app.sceneManager.comparisonOverlay?.root.${width} === ${reference}`
    ), `folder mesh widths ${primary} and ${reference}`);

    await pick('reference', 'reference');
    await until(() => evaluate('app.urdfComparison.active && !app.currentModel'), 'reference selected before primary');
    await pick('primary', 'original');
    await until(() => evaluate('document.querySelector("[data-primary-select]").options.length === 3'), 'primary URDF choices');
    await evaluate(`(() => {
        const select = document.querySelector('[data-primary-select]');
        select.value = [...select.options].find(option => option.textContent === 'robot/robot.urdf').value;
        select.dispatchEvent(new Event('change'));
    })()`);
    await waitForWidths(2, 5);
    assert.deepEqual(await evaluate(`Array.from(document.querySelector('[data-reference-select]').options,
        option => option.textContent).slice(1)`), ['robot/robot.urdf']);
    await pick('primary', 'invalid');
    await until(() => evaluate('document.querySelector("[data-primary-status]").textContent.includes("robot.urdf")'), 'invalid primary error');
    await waitForWidths(2, 5);
    await pick('primary', 'replacement');
    await waitForWidths(7, 5);
    for (const [side, status] of [['primary', '[data-primary-status]'], ['reference', '[data-comparison-status]']]) {
        await pick(side, 'pointer');
        await until(() => evaluate(`/body\.STL.*git lfs pull/.test(document.querySelector('${status}').textContent)`), 'LFS pointer feedback for ' + side);
        await waitForWidths(7, 5);
    }
    await pick('reference', 'original');
    await until(() => evaluate('document.querySelector("[data-comparison-status]").textContent.includes("URDF")'), 'reference URDF choices');
    await evaluate(`(() => {
        const select = document.querySelector('[data-reference-select]');
        select.value = [...select.options].find(option => option.textContent === 'robot/other.urdf').value;
        select.dispatchEvent(new Event('change'));
    })()`);
    await waitForWidths(7, 2);
    await pick('reference', 'replacement');
    await waitForWidths(7, 7);
    console.log('PASS: independent folder pickers, reference-first loading, primary URDF choice, failed and successful replacements, isolated same-named assets');
}
