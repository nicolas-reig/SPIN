export const STATUSES = ['unset', 'ok', 'problem', 'retired'];
export const STATUS_COLORS = {
    unset: '#a1a7ad',
    ok: '#31975c',
    problem: '#d99a22',
    retired: '#798491'
};
export const SELECTION_COLORS = { normal: '#1684ef', edit: '#8056cb' };

export const identity = () => ({
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
});

const finite = number => typeof number === 'number' && Number.isFinite(number);

export class MapPlacement {
    constructor(data = identity()) {
        for (const key of ['position', 'rotation', 'scale']) {
            if (!Array.isArray(data[key]) || data[key].length !== 3 || !data[key].every(finite)) {
                throw Error('invalidTransform');
            }
            this[key] = [...data[key]];
        }
        if (this.scale.some(value => value <= 0)) throw Error('invalidTransform');
    }

    toJSON() {
        return {
            position: [...this.position],
            rotation: [...this.rotation],
            scale: [...this.scale]
        };
    }
}

class Record {
    constructor(data) {
        if (!data?.id || typeof data.id !== 'string') throw Error('invalidId');
        Object.assign(this, structuredClone(data));
    }
}

export class Exhibit extends Record {
    constructor(data) {
        super(data);
        if (!STATUSES.includes(this.status)) throw Error('invalidStatus');
        new MapPlacement(this.transform);
        if (!Array.isArray(this.models)) throw Error('invalidModel');
        this.models.forEach(instance => {
            if (!instance.model) throw Error('invalidModel');
            new MapPlacement(instance.transform);
        });
    }
}

export class Floor extends Record {
    constructor(data) {
        super(data);
        if (!/^(0|-?[1-9][0-9]*)$/.test(this.id) || !this.names?.de || !this.names?.en) {
            throw Error('invalidFloor');
        }
    }
}

export class ModelAsset extends Record {
    constructor(data) {
        super(data);
        if (!this.file || !this.url) throw Error('invalidModel');
    }
}

export class Note extends Record {
    constructor(data) {
        super(data);
        if (!this.author?.trim()) throw Error('signatureRequired');
    }
}

export function safeUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:', 'smb:', 'file:', 'ftp:'].includes(url.protocol) &&
            !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value) &&
            (url.hostname || url.protocol === 'file:');
    } catch {
        return false;
    }
}

export class NasDocumentLink extends Record {
    constructor(data) {
        super(data);
        if (!safeUrl(this.url)) throw Error('invalidUrl');
    }
}

export function validateViews(views = {}) {
    for (const key of ['top', 'three']) {
        const view = views[key];
        if (!view) continue;
        if (![view.position, view.target].every(vector => Array.isArray(vector) && vector.length === 3 &&
            vector.every(finite)) || !finite(view.span) || view.span <= 0) {
            throw Error('invalidView');
        }
    }
}

export function validateSnapshot(snapshot) {
    snapshot.floors.forEach(record => {
        new Floor(record);
        validateViews(record.views);
    });
    snapshot.exhibits.forEach(record => {
        new Exhibit(record);
        validateViews(record.views);
        record.notes.forEach(note => new Note(note));
        record.links.forEach(link => new NasDocumentLink(link));
    });
    snapshot.assets.forEach(asset => new ModelAsset(asset));
    return snapshot;
}

export function structural(record, kind) {
    const keys = kind === 'floors' ? ['id', 'names', 'views'] :
        ['id', 'name', 'floorId', 'status', 'transform', 'models', 'views'];
    return Object.fromEntries(keys.map(key => [key, structuredClone(record[key] ?? null)]));
}

export class EditSession {
    constructor(snapshot) {
        this.base = structuredClone(snapshot);
        this.value = structuredClone(snapshot);
        this.undoStack = [];
        this.redoStack = [];
    }

    change(change) {
        const next = structuredClone(this.value);
        change(next);
        this.undoStack.push(structuredClone(this.value));
        this.redoStack = [];
        this.value = next;
    }

    undo() {
        if (this.undoStack.length) {
            this.redoStack.push(this.value);
            this.value = this.undoStack.pop();
        }
    }

    redo() {
        if (this.redoStack.length) {
            this.undoStack.push(this.value);
            this.value = this.redoStack.pop();
        }
    }

    changes() {
        const changes = [];
        for (const kind of ['floors', 'exhibits']) {
            for (const record of this.value[kind]) {
                const old = this.base[kind].find(item => item.id === record.id);
                if (!old || JSON.stringify(structural(record, kind)) !== JSON.stringify(structural(old, kind))) {
                    changes.push({
                        kind,
                        op: 'put',
                        id: record.id,
                        record: structural(record, kind),
                        baseRevision: old?.revision
                    });
                }
            }
            for (const old of this.base[kind]) {
                if (!this.value[kind].some(item => item.id === old.id)) {
                    changes.push({ kind, op: 'delete', id: old.id, baseRevision: old.revision });
                }
            }
        }
        return changes;
    }
}
