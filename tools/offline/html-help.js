window.addEventListener('DOMContentLoaded', () => {
    document.title = 'Robot Viewer — Offline HTML';
    const brand = document.getElementById('creator-home-link');
    const dialog = document.createElement('dialog');
    dialog.id = 'offline-html-help';
    dialog.style.cssText = 'max-width:520px;max-height:80vh;overflow:auto;padding:24px;border:1px solid #777;border-radius:14px;background:var(--panel-bg,#202124);color:var(--text-color,#eee);font:14px/1.6 system-ui';
    dialog.innerHTML = `<h2 style="margin-top:0">Offline HTML</h2>
        <p>This one file contains the viewer and physics engine. Open it directly in your browser; no server or installation is needed.</p>
        <p>Use <strong>Load files</strong> or <strong>Load folder</strong> for your robot and all its meshes, textures and Xacro includes.</p>
        <p><strong>USD and live connections are excluded.</strong> External requests are blocked. Export edited models and animations to keep a portable copy; browser autosave can depend on this file's location.</p>
        <p><button data-sample="joint-zero-demo.urdf">Try URDF</button> <button data-sample="offline-demo.xacro">Try Xacro</button> <button data-sample="offline-demo.xml">Try MJCF physics</button></p>
        <p>For the MJCF sample, use the physics play/pause control after loading.</p>
        <details><summary>Licenses</summary><pre style="white-space:pre-wrap;font-size:11px"></pre></details>
        <p><button data-close>Close</button></p>`;
    document.body.append(dialog);
    dialog.querySelector('pre').textContent = JSON.parse(document.getElementById('offline-licenses').textContent);
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    if (brand) {
        brand.querySelector('.creator-home-label').textContent = 'Offline HTML';
        brand.setAttribute('role', 'button'); brand.tabIndex = 0;
        brand.setAttribute('aria-label', 'Offline HTML help and sample robots');
        brand.title = 'Offline HTML — help and sample robots';
        brand.onclick = () => dialog.showModal();
        brand.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dialog.showModal(); } };
    }
    // Keep the About panel accurate after language changes as well.
    const originalTranslate = window.i18n.t.bind(window.i18n);
    window.i18n.t = key => {
        const text = originalTranslate(key);
        return key === 'aboutContent' ? text.replace(/、USD（部分支持）|, USD \(partial support\)/g, '') : text;
    };
    const about = document.querySelector('[data-i18n="aboutContent"]');
    if (about) about.innerHTML = window.i18n.t('aboutContent');
    const samples = JSON.parse(document.getElementById('offline-samples').textContent);
    for (const button of dialog.querySelectorAll('[data-sample]')) button.onclick = async () => {
        const name = button.dataset.sample;
        const file = new File([samples[name]], name, { type: 'text/xml' });
        window.app.fileHandler.fileMap.clear();
        window.app.fileHandler.fileMap.set(name, file);
        const models = await window.app.fileHandler.findAllLoadableFiles([file]);
        window.app.fileHandler.availableModels = models;
        window.app.fileHandler.onFilesLoaded?.(models);
        await window.app.fileHandler.loadFile(file);
        dialog.close();
    };
});
