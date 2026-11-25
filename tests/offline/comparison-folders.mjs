import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkComparisonFolders({ call, evaluate, until, temporary }) {
    // All directory imports have the same root and relative paths.
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
    const { root } = await call('DOM.getDocument');
    const add = async version => {
        const count = await evaluate('app.fileHandler.projects.size');
        await evaluate('document.querySelector("[data-add-folder]").click()');
        const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: 'body > input[webkitdirectory]' });
        await call('DOM.setFileInputFiles', { nodeId, files: [folder(version)] });
        await until(() => evaluate(`app.fileHandler.projects.size === ${count + 1}`), 'folder import ' + version);
        return evaluate('Array.from(app.fileHandler.projects.keys()).at(-1)');
    };
    const click = (attribute, id) => evaluate(`document.querySelector('[${attribute}="${id}"]').click()`);
    const choose = (selector, value) => evaluate(`(() => {
        const el = document.querySelector('${selector}');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change'));
    })()`);
    const width = 'visual.body.children[0]?.children[0]?.geometry.attributes.position.getX(1)';
    const widths = (primary, reference) => until(() => evaluate(`app.currentModel?.threeObject.${width} === ${primary} &&
        (app.sceneManager.comparisonOverlay?.root.${width} ?? null) === ${reference}`), 'rendered mesh widths');
    const original = await add('original');
    await widths(2, null);
    await choose('[data-project-model]', 'robot/robot.urdf');
    await until(() => evaluate('app.currentModel.threeObject.robotName === "original"'), 'select second model');
    const ref = await add('reference');
    const spare = await add('replacement');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[data-project-id]"), b => b.textContent)'),
        ['robot', 'robot (2)', 'robot (3)']);
    await widths(2, null);
    await click('data-project-id', ref);
    await widths(5, null);
    await click('data-project-id', original);
    await widths(2, null);
    assert.equal(await evaluate('app.currentModel.threeObject.robotName'), 'original');
    await evaluate('document.querySelector("#urdf-comparison summary").click()');
    await choose('[data-reference-select]', ref + '/robot/robot.urdf');
    await widths(2, 5);

    assert.deepEqual(await evaluate(`(() => {
        const projects = document.getElementById('projects-tab');
        const tree = document.getElementById('file-tree-tab');
        projects.focus();
        projects.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const browsable = document.activeElement === tree && !document.getElementById('model-list').hidden &&
            document.getElementById('projects-page').hidden && !!document.querySelector('#model-list [data-file-path]');
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        return { browsable, returned: document.activeElement === projects && projects.getAttribute('aria-selected') === 'true',
            model: document.querySelector('[data-model-name]').textContent,
            reference: document.querySelector('[data-reference-project]').textContent };
    })()`), { browsable: true, returned: true, model: 'robot.urdf', reference: 'robot (2)' });

    const invalid = await add('invalid');
    const pointer = await add('pointer');
    for (const [id, message] of [[invalid, 'robot.urdf'], [pointer, 'git lfs pull']]) {
        await click('data-project-id', id);
        await until(() => evaluate(`document.querySelector('[data-project-status]').textContent.includes(${JSON.stringify(message)})`), 'failed project feedback');
        await choose('[data-reference-select]', id + '/robot/robot.urdf');
        await until(() => evaluate(`document.querySelector('[data-comparison-status]').textContent.includes(${JSON.stringify(message)})`), 'failed reference feedback');
        await widths(2, 5);
        await click('data-remove-project', id);
    }
    // Removing a pending reference must leave the previous valid comparison visible.
    await evaluate(`(() => {
        const file = app.fileHandler.projects.get('${spare}').assets.get('robot/robot.urdf');
        const text = file.text.bind(file);
        file.text = () => new Promise(resolve => { window.finishReferenceRead = () => resolve(text()); });
    })()`);
    await choose('[data-reference-select]', spare + '/robot/robot.urdf');
    await click('data-remove-project', spare);
    await evaluate('window.finishReferenceRead(); delete window.finishReferenceRead');

    await widths(2, 5);
    await evaluate(`window.disposed = {primary: false, reference: false};
        const watch = (mesh, side) => mesh.geometry.addEventListener('dispose', () => { window.disposed[side] = true; });
        watch(app.sceneManager.comparisonOverlay.root.visual.body.children[0].children[0], 'reference');
        watch(app.currentModel.threeObject.visual.body.children[0].children[0], 'primary');`);
    await click('data-remove-project', ref);
    await widths(2, null);
    assert.deepEqual(await evaluate('window.disposed'), { primary: false, reference: true });
    const brokenFallback = await add('invalid');
    await add('replacement');
    await click('data-remove-project', original);
    await widths(7, null);
    assert.equal(await evaluate('window.disposed.primary'), true);
    await click('data-remove-project', brokenFallback);
    await evaluate('document.querySelector("[data-remove-project]").click()');
    assert.equal(await evaluate(`!app.currentModel && !app.sceneManager.currentModel &&
        !app.fileHandler.projects.size && !app.fileHandler.fileMap.size &&
        !app.codeEditorManager.editorState.currentFile && !app.poseController.model &&
        !document.querySelector('[data-project-id]') && document.querySelector('#urdf-comparison').hidden`), true);
    const files = [folder('original'), folder('reference')];
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await call('Input.dispatchDragEvent', { type, x: 600, y: 400, data: { items: [], files, dragOperationsMask: 1 } });
    }
    await until(() => evaluate('app.fileHandler.projects.size === 2'), 'two physical folders in one drop');
    await widths(2, null);
    const ids = await evaluate('Array.from(app.fileHandler.projects.keys())');
    // Chrome can rename the second root when two dropped directories have the same name.
    const option = await evaluate(`Array.from(document.querySelector('[data-reference-select]').options)
        .find(o => o.value.startsWith('${ids[1]}/') && o.value.endsWith('/robot.urdf'))?.value`);
    assert.ok(option, 'second dropped project available for comparison');
    await choose('[data-reference-select]', option);
    await widths(2, 5);
    await click('data-remove-project', ids[1]);
    await click('data-remove-project', ids[0]);
    console.log('PASS: multi-folder drop, project switching, remembered models, comparison across same-named folders, failed loads, GPU disposal and empty library');
}
