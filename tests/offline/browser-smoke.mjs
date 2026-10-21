// Run with Node.js 22+ and Chrome: node tests/offline/browser-smoke.mjs <package.zip|viewer.html>
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../../tools/offline/server.mjs';

const archive = path.resolve(process.argv[2]);
const standalone = archive.endsWith('.html');
const websiteDirectory = process.argv.find(arg => arg.startsWith('--site='))?.slice(7);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'robot viewer offline '));
let bundle;
const htmlCopy = path.join(temporary, 'Robot Viewer.html');
if (standalone) await fs.copyFile(archive, htmlCopy);
else {
    execFileSync('unzip', ['-q', archive, '-d', temporary]);
    bundle = path.join(temporary, (await fs.readdir(temporary))[0]);
}
const profile = path.join(temporary, 'chrome-profile');
const launcher = standalone ? null : spawn('sh', [path.join(bundle, 'start.sh'), '--port=0', '--no-open'], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
let chrome, ws, probe, website;
const deadline = setTimeout(() => { console.error('Smoke test exceeded 100 seconds'); process.exitCode = 1; launcher?.kill(); chrome?.kill(); ws?.close(); probe?.close(); }, 100000);
const until = async (fn, description) => {
    for (let i = 0; i < 160; i++) {
        const result = await fn();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + description);
};
try {
    const origin = standalone ? null : await new Promise((resolve, reject) => {
        let log = '';
        launcher.stdout.on('data', data => { log += data; const match = log.match(/Open: (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
        launcher.stderr.on('data', data => { log += data; });
        launcher.on('error', reject);
        launcher.once('exit', code => reject(new Error(`Launcher exited ${code}: ${log}`)));
    });
    if (!standalone) console.log('PASS: extracted launcher runs from another directory, including spaces in its path');
    const pageUrl = standalone ? pathToFileURL(htmlCopy).href : origin + '/';
    chrome = spawn(process.env.CHROME_PATH ?? '/usr/bin/google-chrome', [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-background-networking', '--disable-component-update', '--no-first-run',
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1',
        `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
        let logs = '';
        chrome.stderr.on('data', data => { logs += data; const match = logs.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
        chrome.on('error', reject);
        chrome.once('exit', code => reject(new Error(`Chrome exited ${code}: ${logs.slice(-1500)}`)));
    });
    ws = new WebSocket(endpoint); await once(ws, 'open');
    let id = 0;
    const pending = new Map(), external = [], pageErrors = [], logs = [], localRequests = [];
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const n = ++id; pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const p = pending.get(message.id);
            if (p) { pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
        } else if (message.method === 'Network.requestWillBeSent') {
            const url = message.params.request.url;
            if (/^https?:/.test(url) && (standalone || !url.startsWith(origin + '/'))) external.push(url);
            if (url.startsWith('file:')) localRequests.push(url);
        } else if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
        else if (message.method === 'Runtime.consoleAPICalled') logs.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails) + '\n' + logs.slice(-12).join('\n'));
        return result.result.value;
    };
    await call('Network.enable'); await call('Runtime.enable');
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    if (standalone && websiteDirectory) {
        website = await startServer({ root: path.resolve(websiteDirectory), port: 0 });
        const downloads = path.join(temporary, 'website-download');
        await fs.mkdir(downloads);
        await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        await call('Page.navigate', { url: website.origin + '/' });
        await until(() => evaluate('Boolean(window.app?.liveStatePanel && document.readyState === "complete")'), 'website startup');
        await evaluate('i18n.setLanguage("en-US"); document.getElementById("help-button")?.click()');
        assert.deepEqual(await evaluate(`(() => {
            const link = document.getElementById('download-offline-html');
            return { text:link.textContent.trim(), filename:link.download, visible:link.getBoundingClientRect().height > 0 };
        })()`), { text: 'Download offline HTML', filename: 'robot-viewer-offline.html', visible: true });
        await evaluate('document.getElementById("download-offline-html").click()');
        const downloaded = path.join(downloads, 'robot-viewer-offline.html');
        await until(async () => fs.stat(downloaded).then(() => true, () => false), 'website offline download');
        assert.deepEqual(await fs.readFile(downloaded), await fs.readFile(archive));
        await fs.copyFile(downloaded, htmlCopy);
        assert.deepEqual(pageErrors, []);
        external.length = 0; localRequests.length = 0;
        website.server.closeAllConnections();
        await new Promise(resolve => website.server.close(resolve));
        website = null;
        console.log('PASS: website Help/About button downloads the exact standalone HTML');
    }
    await call('Page.navigate', { url: pageUrl });
    await call('Page.bringToFront');
    await until(() => evaluate('Boolean(window.app?.liveStatePanel && document.readyState === "complete")'), 'viewer startup');
    const waitForModelView = () => until(() => evaluate('Boolean(app.currentModel?.threeObject && !document.getElementById("canvas-snapshot"))'), 'model view after loading transition');
    assert.equal(await evaluate('crossOriginIsolated'), !standalone);
    assert.equal(await evaluate('app.liveStatePanel.get("connect").disabled'), true);
    assert.equal(await evaluate('document.querySelectorAll("a[href^=https], a[href^=mailto]").length'), 0);
    if (standalone) {
        assert.equal(await evaluate('document.getElementById("download-offline-html")'), null);
        console.log('PASS: standalone file:// startup without a server or sibling assets');
        await call('Page.setInterceptFileChooserDialog', { enabled: true });
        await evaluate('app.fileTreeView.triggerFileLoad()');
        const { root } = await call('DOM.getDocument');
        const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept*=".urdf"]' });
        assert.ok(nodeId);
        assert.equal(await evaluate('document.querySelector("input[accept*=urdf]").accept.includes("usd")'), false);
        await call('DOM.setFileInputFiles', { nodeId, files: [path.join(repo, 'public/examples/joint-zero-demo.urdf')] });
        await until(() => evaluate('app.currentModel?.joints.has("motor_joint")'), 'file picker import');
        await waitForModelView();
        console.log('PASS: actual file picker imports a robot, and excludes USD');
        await evaluate('document.getElementById("creator-home-link").click()');
        assert.equal(await evaluate('document.getElementById("offline-html-help").open'), true);
        await evaluate('document.querySelector("[data-sample=\\"offline-demo.xacro\\"]").onclick()');
        await waitForModelView();
        assert.equal(await evaluate('app.currentModel.joints.has("arm_joint")'), true);
        console.log('PASS: embedded help and Xacro sample button work');
    }
    const load = async (name, assets = []) => {
        const entries = await Promise.all([name, ...assets].map(async file => ({ name: file, content: await fs.readFile(standalone
            ? path.join(repo, file.startsWith('offline-demo.') ? 'tools/offline/examples' : 'public/examples', file)
            : path.join(bundle, 'samples', file), 'utf8') })));
        await evaluate(`(async () => {
            app.fileHandler.fileMap.clear();
            const entries = ${JSON.stringify(entries)};
            for (const entry of entries) app.fileHandler.fileMap.set(entry.name, new File([entry.content], entry.name.split('/').pop()));
            await app.fileHandler.loadFile(app.fileHandler.fileMap.get(${JSON.stringify(name)}));
        })()`);
        if (!/\.usd[acz]?$/i.test(name)) await waitForModelView();
    };
    await load('joint-zero-demo.urdf');
    assert.equal(await evaluate('app.currentModel.joints.has("motor_joint")'), true);
    await evaluate('app.poseController.setJointValue("motor_joint", 0.5)');
    assert.equal(await evaluate('app.currentModel.joints.get("motor_joint").currentValue'), 0.5);
    console.log('PASS: URDF loads and joint movement works');
    if (standalone) {
        await evaluate('document.getElementById("show-inertia").click()');
        assert.deepEqual(await evaluate(`(() => {
            const v = app.sceneManager.inertialVisualization;
            const b = v.inertiaEllipsoids.get('arm_link');
            return { show:v.showInertia, boxes:v.inertiaEllipsoids.size, visible:b?.visible, ixx:app.currentModel.links.get('arm_link').inertial.ixx };
        })()`), { show: true, boxes: 1, visible: true, ixx: 0.001067 });
        if (process.env.OFFLINE_INERTIA_CHECK) {
            const capture = await call('Page.captureScreenshot', { format: 'png' });
            await fs.writeFile(process.env.OFFLINE_INERTIA_CHECK + '-on.png', Buffer.from(capture.data, 'base64'));
        }
        await evaluate('document.getElementById("show-visual").click()');
        assert.equal(await evaluate('app.sceneManager.inertialVisualization.inertiaEllipsoids.get("arm_link").visible'), true);
        if (process.env.OFFLINE_INERTIA_CHECK) {
            const capture = await call('Page.captureScreenshot', { format: 'png' });
            await fs.writeFile(process.env.OFFLINE_INERTIA_CHECK + '-visual-off.png', Buffer.from(capture.data, 'base64'));
        }
        await evaluate('document.getElementById("show-visual").click(); document.getElementById("show-inertia").click()');
        assert.equal(await evaluate('app.sceneManager.inertialVisualization.inertiaEllipsoids.get("arm_link").visible'), false);
        console.log('PASS: toolbar inertia renders from the URDF tensor and toggles independently of visuals');
        const report = 'Coordinate system: arm_link\nMass = 3 kilograms\nCenter of mass: ( meters )\nX = 0.3\nY = 0\nZ = 0\nMoments of inertia: ( kilograms * square meters )\nLxx = 0.02 Lxy = 0 Lxz = 0\nLyx = 0 Lyy = 0.03 Lyz = 0\nLzx = 0 Lzy = 0 Lzz = 0.04';
        await evaluate(`app.inertiaReportPanel.loadFile(new File([${JSON.stringify(report)}], 'inertia.txt'))`);
        assert.equal(await evaluate('app.inertiaReportPanel.get("error").textContent'), '');
        assert.equal(await evaluate('app.currentModel.links.get("arm_link").inertial.mass'), 3);
        assert.equal(await evaluate('app.sceneManager.inertialVisualization.inertiaEllipsoids.get("arm_link").visible'), true);
        await evaluate('app.inertiaReportPanel.clear(); app.inertiaReportPanel.panel.style.display = "none"');
        assert.equal(await evaluate('app.currentModel.links.get("arm_link").inertial.ixx'), 0.001067);
        assert.equal(await evaluate('app.sceneManager.inertialVisualization.inertiaEllipsoids.size'), 0);
        console.log('PASS: inertia.txt preview displays a box and clearing restores the URDF tensor');
    }
    if (standalone) {
        const downloads = path.join(temporary, 'downloads');
        await fs.mkdir(downloads);
        await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        const downloaded = async suffix => {
            const name = await until(async () => (await fs.readdir(downloads)).find(name => name.endsWith(suffix)), 'download ' + suffix);
            return fs.readFile(path.join(downloads, name), 'utf8');
        };
        await evaluate('document.getElementById("export-pose-btn").click()');
        const pose = JSON.parse(await downloaded('.pose.json'));
        assert.equal(pose.positions[pose.jointNames.indexOf('motor_joint')], 0.5);
        await evaluate(`(async () => {
            const manager = app.codeEditorManager;
            await manager.loadFile(app.fileHandler.currentModelFile);
            manager.codeEditorInstance.setValue(manager.codeEditorInstance.getValue().replace('joint_zero_demo', 'offline_edited_demo'));
            await manager.performSave();
        })()`);
        assert.match(await downloaded('.urdf'), /offline_edited_demo/);
        await evaluate(`(() => {
            const workspace = app.animationWorkspace;
            workspace.store.upsertKeyframe('motor_joint', 0, 0, { interpolation: 'linear' });
            workspace.store.upsertKeyframe('motor_joint', 1000, 1, { interpolation: 'linear' });
            workspace.playback.seek(500);
        })()`);
        assert.ok(Math.abs(await evaluate('app.currentModel.joints.get("motor_joint").currentValue') - 0.5) < 1e-8);
        await evaluate('app.animationWorkspace.exportAnimation()');
        const animation = JSON.parse(await downloaded('.robotanim.json'));
        assert.equal(animation.clips[0].tracks.find(track => track.jointName === 'motor_joint').keyframes.length, 2);
        console.log('PASS: edited URDF, pose JSON and animation files download; animation interpolation works');
    }
    await load('urdf-transform-demo.urdf', ['meshes/demo-arm.obj', 'meshes/demo-tool.obj']);
    assert.ok(await evaluate('app.currentModel.links.size > 1'));
    assert.ok(await evaluate('(() => { let count = 0; app.currentModel.threeObject.traverse(o => { if(o.isMesh) count++; }); return count; })()') > 0);
    console.log('PASS: URDF with local OBJ assets loads');
    await load('offline-demo.xacro');
    assert.equal(await evaluate('app.currentModel.joints.has("arm_joint")'), true);
    console.log('PASS: Xacro expansion and loading');
    await load('offline-demo.xml');
    assert.equal(await evaluate('Boolean(app.currentMJCFFile && app.currentMJCFModel)'), true);
    assert.equal(await evaluate('app.handleMujocoToggleSimulate()'), true);
    const physicsMoved = await evaluate(`(() => {
        const manager = app.mujocoSimulationManager;
        manager.reset(); manager.mujoco_time = 0; manager.update(10);
        const positions = () => Array.from(manager.isOldAPI ? manager.data.xpos : manager.simulation.xpos);
        const before = positions();
        // Controlled frame times avoid software-renderer frame throttling.
        for (let i = 0; i < 20; i++) manager.update(manager.mujoco_time + 10);
        const after = positions(); app.handleMujocoToggleSimulate();
        return before.some((value, index) => Math.abs(value - after[index]) > 0.001);
    })()`);
    assert.equal(physicsMoved, true);
    console.log('PASS: MJCF loads and MuJoCo moves the falling body with controlled frame times');
    if (standalone) {
        const dialogOpened = new Promise(resolve => {
            const onMessage = event => {
                const message = JSON.parse(event.data);
                if (message.method === 'Page.javascriptDialogOpening') { ws.removeEventListener('message', onMessage); resolve(message.params.message); }
            };
            ws.addEventListener('message', onMessage);
        });
        const loadAttempt = evaluate('app.fileHandler.loadFile(new File(["#usda 1.0"], "test.usda"))');
        assert.match(await dialogOpened, /USD/);
        await call('Page.handleJavaScriptDialog', { accept: true });
        await loadAttempt;
        assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0);
        console.log('PASS: USD displays an exclusion message without loading an iframe');
    } else {
        await load('offline-demo.usda');
        await until(() => evaluate(`(() => {
            const inner = document.querySelector('iframe')?.contentWindow?.document.querySelector('iframe')?.contentWindow;
            let count = 0; inner?.usdRoot?.traverse(o => { if (o.isMesh) count++; }); return count;
        })()`), 'USD geometry');
        console.log('PASS: USD engine, worker, data, HDR and Three.js produce geometry');
    }
    const screenshot = process.env.OFFLINE_SCREENSHOT;
    if (screenshot) {
        const capture = await call('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(screenshot, Buffer.from(capture.data, 'base64'));
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(external, []);
    if (standalone) assert.deepEqual(localRequests, [pageUrl]);
    console.log('PASS: no external requests or uncaught browser errors during model tests');
    if (standalone) {
        await call('Page.reload', { ignoreCache: true });
        await until(() => evaluate('Boolean(window.app?.liveStatePanel && document.readyState === "complete")'), 'file reload');
        await evaluate('document.querySelector("[data-sample=\\"joint-zero-demo.urdf\\"]").onclick()');
        await waitForModelView();
        assert.equal(await evaluate('app.currentModel.joints.has("motor_joint")'), true);
        assert.deepEqual(external, []);
        assert.deepEqual(pageErrors, []);
        console.log('PASS: standalone reload and built-in URDF sample with external access blocked');
        if (screenshot) {
            await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const capture = await call('Page.captureScreenshot', { format: 'png' });
            await fs.writeFile(screenshot, Buffer.from(capture.data, 'base64'));
        }
    }

    let probeHits = 0;
    probe = http.createServer((req, res) => { probeHits++; res.end('unexpected'); });
    probe.on('upgrade', (req, socket) => { probeHits++; socket.destroy(); });
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const probeUrl = `http://127.0.0.1:${probe.address().port}/blocked`;
    const violations = await evaluate(`(async () => {
        const violations = [];
        document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
        await fetch(${JSON.stringify(probeUrl)}).catch(() => {});
        const img = new Image(); img.src = ${JSON.stringify(probeUrl)};
        const socket = new WebSocket(${JSON.stringify(probeUrl.replace('http:', 'ws:'))}); socket.onerror = () => {};
        await new Promise(resolve => setTimeout(resolve, 300));
        return violations;
    })()`);
    assert.equal(probeHits, 0);
    assert.ok(violations.includes('connect-src'));
    assert.ok(violations.includes('img-src'));
    console.log('PASS: browser policy blocks HTTP, image and WebSocket requests to another origin');
} finally {
    clearTimeout(deadline);
    ws?.close(); probe?.close();
    if (website) { website.server.closeAllConnections(); website.server.close(); }
    for (const process of [chrome, launcher]) if (process && process.exitCode === null) {
        const exited = once(process, 'exit'); process.kill(); await exited;
    }
    await fs.rm(temporary, { recursive: true, force: true });
}
