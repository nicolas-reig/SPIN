import { identity, structural, EditSession, VIEW_KEYS, coordinateNumber } from './domain.js';
import { escape as esc } from './markdown.js';
import { t } from './locale.js';
import { icon } from './icons.js';

export function editHelp(key) {
    const text = esc(t(key));
    return `title="${text}" aria-description="${text}"`;
}

export const transformNumber = coordinateNumber;

export function vectorFields(transform, attributes = '', scope = 'group', { group = scope === 'group', labels = {}, hints = {}, keys = ['position', 'rotation', 'scale'], disabled = false } = {}) {
    return keys.map(key => {
        const help = editHelp(hints[key] || key + (group ? 'GroupHint' : 'InstanceHint'));
        const label = t(labels[key] || key);
        return `
        <div class="vector"><h3 ${help}>${esc(label)}</h3><div class="axis-values">
            ${['X', 'Y', 'Z'].map((axis, index) => {
                const id = `transform-${scope}-${key}-${index}`;
                const value = transform[key][index];
                return `<div class="axis-value"><label data-number-drag for="${id}" title="${esc(t('dragValueHint'))}">${axis}</label><input id="${id}" aria-label="${esc(label + ' · ' + axis)}" ${help} type="number" step="any" min="${key === 'scale' ? '-1000' : '-100000'}" max="${key === 'scale' ? '1000' : '100000'}" data-vector="${key}" data-axis="${index}" ${attributes} ${disabled ? 'disabled' : ''} placeholder="${esc(t('mixedValues'))}" value="${value == null ? '' : transformNumber(value)}"></div>`;
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
        notes: [], links: [], placed: false, createdAt: new Date().toISOString()
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
    } while (records.some(item => [item.id, item.name, ...(item.joinedFrom || [])].some(value => value.toLocaleLowerCase() === name.toLocaleLowerCase())));
    copy.id = copy.name = name;
    copy.transform.position[0] += 2;
    copy.notes = [];
    copy.links = [];
    copy.revision = null;
    copy.createdAt = new Date().toISOString();
    delete copy.contentTag;
    delete copy.joinedFrom;
    return copy;
}

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const fields = ['name', 'floorId', 'transform', 'models', 'views.2D', 'views.3D', 'joinedFrom'];
const get = (record, field) => field.split('.').reduce((value, key) => value?.[key], record);
function put(record, field, value) {
    const parts = field.split('.');
    const last = parts.pop();
    let target = record;
    for (const key of parts) target = target[key] ||= {};
    if (value === undefined) delete target[last];
    else target[last] = structuredClone(value);
}

export function editWasSaved(session, live) {
    const changes = session.changes();
    const targets = new Set(changes.filter(change => change.op === 'put').map(change => change.record.name));
    return changes.length > 0 && changes.every(change => {
        const records = live[change.kind];
        if (change.op === 'delete') return targets.has(change.id) || !records.some(record => record.id === change.id);
        const target = change.record.name;
        const record = records.find(item => item.id === target);
        if (change.joins?.some(source => !targets.has(source.id) && records.some(item => item.id === source.id))) return false;
        if (target !== change.id && !targets.has(change.id) && records.some(item => item.id === change.id)) return false;
        return record && equal(structural(record), { ...change.record, id: target });
    });
}

export function rebaseEdit(session, live, choices = {}) {
    const next = new EditSession(live);
    const conflicts = [];
    const choose = (change, field, current, yours, extra = {}) => {
        const key = JSON.stringify([change.kind, change.id, field]);
        if (!choices[key]) conflicts.push({ key, kind: change.kind, id: change.id, field, current, yours, ...extra });
        return choices[key] === 'mine' && !extra.unavailable;
    };
    next.change(state => {
        for (const change of session.changes()) {
            const base = session.base[change.kind].find(record => record.id === change.id);
            const current = state[change.kind].find(record => record.id === change.id);
            const desired = session.value[change.kind].find(record => record.id === change.id);
            if (change.joins?.length) {
                const sources = change.joins.map(source => ({
                    base: session.base.exhibits.find(item => item.id === source.id),
                    current: state.exhibits.find(item => item.id === source.id)
                }));
                const missing = Boolean(base && !current || sources.some(source => !source.current));
                const shape = record => structural({ ...record, status: 'ok' });
                const members = [...(base ? [{ base, current }] : []), ...sources];
                const altered = missing || !base && current || members.some(member => !equal(shape(member.base), shape(member.current)) || member.base.contentTag !== member.current.contentTag);
                if (altered && !choose(change, 'join', { joinMembers: members.map(member => member.current).filter(Boolean) },
                    { joinMembers: [desired] }, { unavailable: missing })) continue;
                const record = structuredClone(desired);
                const content = [current, ...sources.map(source => source.current)].filter(Boolean);
                record.notes = content.flatMap(item => item.notes);
                record.links = content.flatMap(item => item.links);
                record.status = current?.status || record.status;
                record.revision = current?.revision || null;
                if (current?.contentTag) record.contentTag = current.contentTag;
                else delete record.contentTag;
                const exists = state.exhibits.some(item => item.id === change.id);
                state.exhibits = state.exhibits.flatMap(item => item.id === change.id ? [record] : change.joins.some(source => source.id === item.id) ? [] : [item]);
                if (!exists) state.exhibits.push(record);
                continue;
            }
            if (change.op === 'delete') {
                if (!current) continue;
                if ((!equal(structural(base), structural(current)) || base.contentTag !== current.contentTag) &&
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
