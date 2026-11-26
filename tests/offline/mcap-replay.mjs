import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { encoderTopic, mcapFile } from '../fixtures/mcap.mjs';

export async function checkMcapReplay({ call, evaluate, until, temporary }) {
    const file = await mcapFile([encoderTopic]);
    const filename = path.join(temporary, 'bench-capture-with-a-long-recording-filename-encoder.mcap');
    await fs.writeFile(filename, new Uint8Array(await file.arrayBuffer()));
    await call('Page.setInterceptFileChooserDialog', { enabled: true });
    await evaluate('app.liveStatePanel.root.open = true');
    assert.equal(await evaluate('document.getElementById("motion-live").hidden'), true);
    await evaluate('document.getElementById("motion-live-tab").click()');
    assert.equal(await evaluate('document.getElementById("motion-playback").hidden'), true);
    assert.equal(await evaluate('app.liveStatePanel.get("record").disabled'), true);
    await evaluate('document.getElementById("motion-playback-tab").click(); app.liveStatePanel.get("import").click()');
    const { root } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '.live-state-panel input[accept*=".mcap"]' });
    assert.ok(nodeId);
    await call('DOM.setFileInputFiles', { nodeId, files: [filename] });
    await until(() => evaluate('Boolean(document.querySelector(".mcap-mapping .mcap-topic"))'), 'MCAP topic rules');
    await evaluate(`(() => {
        const dialog = document.querySelector('.mcap-mapping');
        dialog.querySelector('.mcap-topic input').click();
        const [positions, names] = dialog.querySelectorAll('input[list]');
        positions.value = 'feedback.degrees'; names.value = 'feedback.labels';
        dialog.querySelector('select').value = 'deg';
        dialog.querySelector('[data-next]').click();
    })()`);
    await until(() => evaluate('Boolean(document.querySelector(".mcap-joint select"))'), 'MCAP joint mappings');
    assert.match(await evaluate('document.querySelector(".mcap-joint").textContent'), /shaft/);
    assert.equal(await evaluate('document.querySelector(".mcap-mapping [data-next]").disabled'), true);
    await evaluate(`document.querySelector('.mcap-joint select').value = 'motor_joint';
        document.querySelector('.mcap-joint select').dispatchEvent(new Event('change'));
        document.querySelector('.mcap-mapping [data-next]').click();`);
    assert.equal(await evaluate('app.liveStatePanel.recording.count'), 2);
    assert.equal(await evaluate('app.liveStatePanel.get("name").textContent'), path.basename(filename));
    assert.equal(await evaluate('(() => { const body = document.querySelector(".motion-body"); return body.scrollWidth <= body.clientWidth; })()'), true);
    assert.equal(await evaluate('app.liveStatePanel.get("segment-label").hidden'), true);
    await evaluate('app.liveStatePanel.get("replay").click()');
    await until(() => evaluate('app.liveStatePanel.get("status").textContent === "Replay complete"'), 'MCAP replay completion');
    assert.equal(await evaluate('app.currentModel.threeObject.joints.motor_joint.angle'), Math.PI / 4);

    // Reconfigure from the original MCAP. Canceling must preserve the active recording.
    await evaluate('app.liveStatePanel.get("remap").click()');
    await until(() => evaluate('Boolean(document.querySelector(".mcap-mapping input[list]"))'), 'reopen MCAP rules');
    assert.equal(await evaluate('document.querySelector(".mcap-mapping input[list]").value'), 'feedback.degrees');
    await evaluate('document.querySelector(".mcap-mapping [data-next]").click()');
    await until(() => evaluate('Boolean(document.querySelector(".mcap-joint select"))'), 'saved MCAP joint mapping');
    assert.equal(await evaluate('document.querySelector(".mcap-joint select").value'), 'motor_joint');
    await evaluate('document.querySelector(".mcap-mapping [data-unmapped]").click()');
    assert.equal(await evaluate('document.querySelector(".mcap-mapping [data-filter-empty]").hidden'), false);
    await evaluate(`document.querySelector('.mcap-mapping [data-unmapped]').click();
        document.querySelector('.mcap-joint select').value = '';
        document.querySelector('.mcap-joint select').dispatchEvent(new Event('change'));
        document.querySelector('.mcap-mapping [data-next]').click();`);
    assert.match(await evaluate('document.querySelector(".mcap-mapping [data-feedback]").textContent'), /Map at least one/);
    await evaluate(`document.querySelector('.mcap-mapping [data-cancel]').click();
        app.liveStatePanel.get('local').click(); app.liveStatePanel.root.open = false;`);
    assert.equal(await evaluate('app.liveStatePanel.recording.count'), 2);
    console.log('PASS: MCAP file picker, topic and joint mappings, URDF replay, saved rules and cancellation');
}
