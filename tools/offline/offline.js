// Network enforcement comes from server headers or the standalone HTML policy.
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('offline-download-section')?.remove();
    document.title = 'Robot Viewer — Offline test';
    const brand = document.getElementById('creator-home-link');
    if (brand) {
        brand.removeAttribute('href');
        brand.removeAttribute('target');
        brand.setAttribute('aria-label', 'Offline test version');
        brand.title = 'Offline test — files stay on this computer';
        brand.querySelector('.creator-home-label')?.removeAttribute('data-i18n');
        brand.querySelector('.creator-home-label').textContent = 'Offline test';
        brand.querySelector('.creator-home-arrow')?.remove();
    }
    for (const anchor of document.querySelectorAll('a[href]')) {
        const url = new URL(anchor.getAttribute('href'), location.href);
        if (url.origin !== location.origin) {
            anchor.removeAttribute('href');
            anchor.removeAttribute('target');
            anchor.setAttribute('aria-disabled', 'true');
            anchor.title = 'External links are disabled in the offline test version';
        }
    }
    const panel = window.app?.liveStatePanel;
    if (panel) {
        panel.disconnect();
        panel.connect = () => panel.setStatus('Disabled in offline test');
        panel.setStatus('Disabled in offline test');
        for (const name of ['endpoint', 'connect', 'disconnect', 'record']) {
            panel.get(name).disabled = true;
            panel.get(name).title = 'Live connections are disabled in the offline test version';
        }
        panel.get('diagnostics').textContent = 'Offline test: live connections are disabled. Saved recordings can still be imported and replayed.';
    }
});
