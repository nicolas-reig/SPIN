import { identity, structural, EditSession, VIEW_KEYS } from './domain.js';
import { escape as esc } from './markdown.js';
import { t } from './locale.js';
import { icon } from './icons.js';

export function editHelp(key) {
    const text = esc(t(key));
    return `title="${text}" aria-description="${text}"`;
}

export function vectorFields(transform, attributes = '', scope = 'group') {
    return ['position', 'rotation', 'scale'].map(key => {
        const help = editHelp(key + (scope === 'group' ? 'GroupHint' : 'InstanceHint'));
        return `
        <div class="vector"><h3 ${help}>${esc(t(key))}</h3><div class="grid3">
            ${['X', 'Y', 'Z'].map((axis, index) => {
                const id = `transform-${scope}-${key}-${index}`;
                return `<div><label for="${id}">${axis}</label><input id="${id}" aria-label="${esc(t(key) + ' · ' + axis)}" ${help} type="number" step="any" min="${key === 'scale' ? '.001' : '-100000'}" max="${key === 'scale' ? '1000' : '100000'}" data-vector="${key}" data-axis="${index}" ${attributes} value="${Number(transform[key][index].toFixed(4))}"></div>`;
            }).join('')}
        </div></div>`;
    }).join('');
}

export function viewPresets(record) {
    return `<details class="view-presets"><summary ${editHelp('defaultViewsHint')}>${esc(t('defaultViews'))}</summary>
        ${VIEW_KEYS.map(key => {
            const saved = Boolean(record.views?.[key]);
            const previewHelp = key === '2D'
                ? saved ? 'previewTopHint' : 'automaticTopHint'
                : saved ? 'previewThreeHint' : 'automaticThreeHint';
            return `<div class="preset-row">
            <span class="preset-type" ${editHelp(key === '2D' ? 'topViewHint' : 'threeViewHint')}>${esc(t(key === '2D' ? 'view2D' : 'view3D'))}</span>
            <button type="button" class="icon-button" data-preview-view="${key}" aria-label="${esc(t('showView') + ' · ' + t(key === '2D' ? 'view2D' : 'view3D'))}" ${editHelp(previewHelp)}>${icon('eye')}</button>
            <button type="button" class="icon-button" data-set-view="${key}" aria-label="${esc(t('useCurrentView') + ' · ' + t(key === '2D' ? 'view2D' : 'view3D'))}" ${editHelp(key === '2D' ? 'captureTopHint' : 'captureThreeHint')}>${icon('camera')}</button>
            <button type="button" class="icon-button" data-reset-view="${key}" aria-label="${esc(t('automatic') + ' · ' + t(key === '2D' ? 'view2D' : 'view3D'))}" ${editHelp(saved ? 'resetViewHint' : 'alreadyAutomaticHint')} ${saved ? '' : 'disabled'}>${icon('rotate-ccw')}</button>
        </div>`;
        }).join('')}
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
const fields = ['floorId', 'transform', 'models', 'views.2D', 'views.3D'];
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
                if (!equal(structural(base), structural(current)) &&
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
                for (const field of fields) {
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
