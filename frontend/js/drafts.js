import { normalizeViews } from './domain.js';

const text = value => typeof value === 'string' && value.trim();
export const hasNoteDraft = draft => Boolean(text(draft?.body) || draft?.images?.length ||
    draft?.existingImages?.length || draft?.noteId || text(draft?.signature));
export const hasLinkDraft = draft => Boolean(draft?.id || text(draft?.title) ||
    text(draft?.url) || text(draft?.description));

export class DraftStore {
    constructor(dataset, storage = sessionStorage) {
        this.prefix = 'hub-session-' + dataset + '-';
        this.storage = storage;
    }

    read(name) {
        try {
            const value = JSON.parse(this.storage.getItem(this.prefix + name) || 'null');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch {
            return null;
        }
    }

    write(name, value) {
        if (!value || !Object.keys(value).length) this.storage.removeItem(this.prefix + name);
        else this.storage.setItem(this.prefix + name, JSON.stringify(value, (key, item) =>
            ['saving', 'readingImages', 'controller'].includes(key) ? undefined : item));
    }

    migrate(dataset, legacy = localStorage) {
        for (const [old, name] of [['hub-drafts-', 'notes'], ['hub-edit-', 'edit']]) {
            const key = old + dataset;
            const value = legacy.getItem(key);
            if (value && !this.read(name)) this.write(name, JSON.parse(value));
            legacy.removeItem(key);
        }
    }
}

export function editSnapshot(value) {
    return { ...value, exhibits: value.exhibits.map(({ notes, links, ...record }) => record) };
}

export function restoreEditSnapshot(value, live) {
    return { ...value, floors: structuredClone(live.floors), assets: live.assets, exhibits: value.exhibits.map(record => {
        const current = live.exhibits.find(item => item.id === record.id);
        return { ...record, views: normalizeViews(record.views), notes: current?.notes || [], links: current?.links || [] };
    }) };
}
