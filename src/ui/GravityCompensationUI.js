/**
 * GravityCompensationUI - Presents gravity-compensation torques
 *
 * Drives two synchronized views, both updated on every pose change while
 * enabled:
 *   1. Inline read-only "g:" field next to each joint slider (toggled via the
 *      `gravity-mode` body class, styled in index.html).
 *   2. A floating summary panel (#floating-gravity-panel) listing every joint
 *      plus the total supported mass.
 */

import { GravityCompensation } from '../utils/GravityCompensation.js';

export class GravityCompensationUI {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.enabled = false;
    }

    /** Enable/disable the gravity-compensation display. */
    setEnabled(enabled) {
        this.enabled = enabled;
        document.body.classList.toggle('gravity-mode', enabled);

        const panel = document.getElementById('floating-gravity-panel');
        if (panel) {
            panel.style.display = enabled ? 'flex' : 'none';
        }

        if (enabled) {
            this.update();
        }
    }

    /** Recompute and refresh both views (no-op when disabled). */
    update() {
        if (!this.enabled) return;
        const model = this.sceneManager ? this.sceneManager.currentModel : null;
        if (!model) {
            this._refreshInline(null);
            this._refreshSummary(null);
            return;
        }
        const result = GravityCompensation.compute(model);
        this._refreshInline(result);
        this._refreshSummary(result);
    }

    _formatValue(info) {
        if (!info || !Number.isFinite(info.value)) return '—';
        return `${info.value.toFixed(2)} ${info.unit}`;
    }

    _refreshInline(result) {
        const els = document.querySelectorAll('.joint-gravity-value');
        els.forEach((el) => {
            const name = el.getAttribute('data-joint-gravity');
            const info = result ? result.joints.get(name) : null;
            el.textContent = this._formatValue(info);
        });
    }

    _refreshSummary(result) {
        const body = document.getElementById('gravity-summary-body');
        if (!body) return;

        body.innerHTML = '';

        if (!result || result.joints.size === 0) {
            const row = document.createElement('div');
            row.className = 'gravity-summary-empty';
            row.textContent = result && !result.hasMass
                ? window.i18n.t('gravityNoMass')
                : window.i18n.t('noModel');
            body.appendChild(row);
            this._setTotalMass(result ? result.totalMass : 0);
            return;
        }

        result.joints.forEach((info, name) => {
            const row = document.createElement('div');
            row.className = 'gravity-summary-row';

            const nameCell = document.createElement('span');
            nameCell.className = 'gravity-summary-name';
            nameCell.textContent = name;
            nameCell.title = name;

            const valueCell = document.createElement('span');
            valueCell.className = 'gravity-summary-value';
            valueCell.textContent = this._formatValue(info);

            row.appendChild(nameCell);
            row.appendChild(valueCell);
            body.appendChild(row);
        });

        this._setTotalMass(result.totalMass);
    }

    _setTotalMass(totalMass) {
        const el = document.getElementById('gravity-total-mass');
        if (el) {
            el.textContent = `${(totalMass || 0).toFixed(3)} kg`;
        }
    }
}
