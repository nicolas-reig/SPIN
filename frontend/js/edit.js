import { identity, structural, EditSession } from './domain.js';
import { escape as esc } from './markdown.js';
import { t } from './locale.js';

const svg = path => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

export const editIcons = {
    undo: svg('M8 4 3 9l5 5M3 9h11a5 5 0 0 1 0 10h-3'),
    redo: svg('m16 4 5 5-5 5M21 9H10a5 5 0 0 0 0 10h3'),
    translate: svg('M12 3v18M3 12h18m-12-6 3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3'),
    rotate: svg('M20 8a8 8 0 1 0 0 8M20 3v5h-5'),
    scale: svg('M4 9V4h5m6 16h5v-5M4 4l6 6m10 10-6-6'),
    duplicate: svg('M9 4H4v13h5m0-10h11v14H9V7Zm5 4v6m-3-3h6'),
    capture: svg('M12 3v4m0 10v4M3 12h4m10 0h4M7 7h10v10H7V7Z'),
    settings: svg('M4 7h6m4 0h6M4 17h10m4 0h2M10 4v6m4 4v6')
};

export function vectorFields(transform, attributes = '', scope = 'group') {
    return ['position', 'rotation', 'scale'].map(key => `
        <div class="vector"><h3>${esc(t(key))}</h3><div class="grid3">
            ${['X', 'Y', 'Z'].map((axis, index) => {
                const id = `transform-${scope}-${key}-${index}`;
                return `<div><label for="${id}">${axis}</label><input id="${id}" aria-label="${esc(t(key) + ' · ' + axis)}" type="number" step="any" min="${key === 'scale' ? '.001' : '-100000'}" max="${key === 'scale' ? '1000' : '100000'}" data-vector="${key}" data-axis="${index}" ${attributes} value="${Number(transform[key][index].toFixed(4))}"></div>`;
            }).join('')}
        </div></div>`).join('');
}

export function viewPresets(record) {
    return `<details class="view-presets"><summary>${esc(t('defaultViews'))}</summary>
        ${['top', 'three'].map(key => `<div class="preset-row">
            <span>${esc(t(key === 'top' ? 'view2D' : 'view3D'))}</span>
            <button type="button" class="quiet" data-preview-view="${key}" title="${esc(record.views?.[key] ? t('showView') : t('viewFallback'))}">${esc(t(record.views?.[key] ? 'showView' : 'automatic'))}</button>
            <button type="button" class="icon-button" data-set-view="${key}" aria-label="${esc(t('useCurrentView') + ' · ' + t(key === 'top' ? 'view2D' : 'view3D'))}" title="${esc(t('useCurrentView'))}">${editIcons.capture}</button>
            <button type="button" class="icon-button" data-reset-view="${key}" aria-label="${esc(t('automatic') + ' · ' + t(key === 'top' ? 'view2D' : 'view3D'))}" title="${esc(t('automatic'))}" ${record.views?.[key] ? '' : 'disabled'}>×</button>
        </div>`).join('')}
    </details>`;
}

export function exhibitName(value) {
    const name = value.trim();
    if (!name || new TextEncoder().encode(name).length > 160 || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
        /^[.]/.test(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
        throw Error('invalidExhibitName');
    }
    return name;
}

export function newExhibit(name, floorId) {
    return {
        id: exhibitName(name), name: exhibitName(name), floorId: floorId || null, status: 'ok',
        transform: identity(), models: [], views: {}, revision: null,
        notes: [], links: [], placed: false
    };
}

export function duplicateExhibit(record, records) {
    const copy = structuredClone(record);
    let number = 2;
    let name;
    do {
        const suffix = ` (${number++})`;
        let stem = record.name;
        while (new TextEncoder().encode(stem + suffix).length > 160) stem = stem.slice(0, -1);
        name = stem + suffix;
    } while (records.some(item => item.id.toLocaleLowerCase() === name.toLocaleLowerCase()));
    copy.id = copy.name = name;
    copy.transform.position[0] += 2;
    copy.notes = [];
    copy.links = [];
    copy.revision = null;
    delete copy.contentTag;
    return copy;
}

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const fields = {
    floors: ['names.de', 'names.en', 'views.top', 'views.three'],
    exhibits: ['floorId', 'status', 'transform', 'models', 'views.top', 'views.three']
};
const get = (record, field) => field.split('.').reduce((value, key) => value?.[key], record);
function put(record, field, value) {
    const parts = field.split('.');
    const last = parts.pop();
    let target = record;
    for (const key of parts) target = target[key] ||= {};
    if (value === undefined) delete target[last];
    else target[last] = structuredClone(value);
}

export function rebaseEdit(session, live, choices = {}) {
    const next = new EditSession(live);
    const conflicts = [];
    const choose = (change, field, current, yours) => {
        const key = JSON.stringify([change.kind, change.id, field]);
        if (!choices[key]) conflicts.push({ key, kind: change.kind, id: change.id, field, current, yours });
        return choices[key] === 'mine';
    };
    next.change(state => {
        for (const change of session.changes()) {
            const base = session.base[change.kind].find(record => record.id === change.id);
            const current = state[change.kind].find(record => record.id === change.id);
            const desired = session.value[change.kind].find(record => record.id === change.id);
            if (change.op === 'delete') {
                if (!current) continue;
                if (!equal(structural(base, change.kind), structural(current, change.kind)) &&
                    !choose(change, 'record', current, null)) continue;
                state[change.kind] = state[change.kind].filter(record => record.id !== change.id);
            } else if (!base || !current) {
                if ((!base && current || base && !current) && !choose(change, 'record', current, desired)) continue;
                const record = structuredClone(desired);
                if (change.kind === 'exhibits') {
                    record.notes = current?.notes || [];
                    record.links = current?.links || [];
                    record.revision = current?.revision || null;
                    if (current?.contentTag) record.contentTag = current.contentTag;
                    else delete record.contentTag;
                }
                const index = state[change.kind].findIndex(item => item.id === change.id);
                if (index < 0) state[change.kind].push(record);
                else state[change.kind][index] = record;
            } else {
                for (const field of fields[change.kind]) {
                    const original = get(base, field), yours = get(desired, field), theirs = get(current, field);
                    if (equal(original, yours) || equal(yours, theirs)) continue;
                    if (!equal(original, theirs) && !choose(change, field, theirs, yours)) continue;
                    put(current, field, yours);
                }
            }
        }
        state.exhibits.forEach(record => { record.placed = Boolean(record.floorId && record.models.length); });
    });
    return { session: next, conflicts };
}
