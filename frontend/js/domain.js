export const STATUSES = ['ok', 'problem', 'retired'];
export const STATUS_COLORS = {
    ok: '#31975c',
    problem: '#d99a22',
    retired: '#65717d'
};
export const SELECTION_COLORS = { normal: '#1684ef', edit: '#8056cb' };
export const normalizeStatus = status => status == null || status === '' || status === 'unset' ? 'ok' : status;

export const identity = () => ({
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
});

const finite = number => typeof number === 'number' && Number.isFinite(number);

export function validTransform(transform) {
    return ['position', 'rotation', 'scale'].every(key => Array.isArray(transform?.[key]) &&
        transform[key].length === 3 && transform[key].every(value => finite(value) &&
            Math.abs(value) <= 100000 && (key !== 'scale' || value >= .001 && value <= 1000)));
}

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
        this.status = normalizeStatus(this.status);
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
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return false;
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    if (!match) return false;
    const scheme = match[1].toLowerCase();
    if (['javascript', 'vbscript', 'data', 'blob', 'filesystem'].includes(scheme)) return false;
    const target = value.slice(match[0].length);
    if (scheme === 'file' && !target) return false;
    const authority = /^\/\/([^/?#]*)/.exec(target);
    if (authority?.[1].includes('@')) return false;
    if (['http', 'https', 'smb', 'ftp'].includes(scheme) && !authority?.[1]) return false;
    try {
        const url = new URL(value);
        return !url.username && !url.password;
    } catch {
        return false;
    }
}

export function documentUrl(value) {
    if (typeof value !== 'string') return null;
    const input = value.trim();
    if (input.length > 2048) return null;
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(input);
    const hostWithPort = !input.includes('://') && /^[^/?#:]+\.[^/?#:]*:\d*(?:[/?#]|$)/.test(input);
    if (hasScheme && !hostWithPort) return safeUrl(input) ? input : null;
    if (/[\s\\\x00-\x20\x7f]/u.test(input)) return null;
    const parts = /^(\[[^\]]+\]|[^/?#:]+)(?::([0-9]+))?([/?#].*)?$/.exec(input);
    if (!parts || parts[2] && (parts[2].length > 5 || Number(parts[2]) > 65535)) return null;
    const host = parts[1];
    if (host.includes('%')) return null;
    const result = 'http://' + input;
    if (result.length > 2048) return null;
    try {
        const parsed = new URL(result);
        if (host.startsWith('[')) {
            if (!parsed.hostname.startsWith('[')) return null;
        } else if (/^[0-9.]+$/.test(parsed.hostname)) {
            const octets = host.split('.');
            if (octets.length !== 4 || !octets.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) return null;
        } else {
            const domain = parsed.hostname.replace(/\.$/, '');
            const labels = domain.split('.');
            if (domain.length > 253 || labels.length < 2 ||
                !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
        }
        return safeUrl(result) ? result : null;
    } catch {
        return null;
    }
}

export const opensInBrowser = value => /^(https?|ftp|file):/i.test(value);

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
        record.status = new Exhibit(record).status;
        validateViews(record.views);
        record.notes.forEach(note => new Note(note));
        record.links.forEach(link => new NasDocumentLink(link));
    });
    snapshot.assets.forEach(asset => new ModelAsset(asset));
    return snapshot;
}

export function structural(record) {
    const keys = ['id', 'name', 'floorId', 'status', 'transform', 'models', 'views'];
    return Object.fromEntries(keys.map(key => [key, structuredClone(record[key] ?? null)]));
}

export class EditSession {
    constructor(snapshot) {
        this.base = this.copy(snapshot);
        this.base.exhibits.forEach(record => { record.status = normalizeStatus(record.status); });
        this.value = this.copy(this.base);
        this.undoStack = [];
        this.redoStack = [];
    }

    copy(value) {
        const copy = structuredClone({ ...value, exhibits: value.exhibits.map(({ notes, links, ...record }) => record) });
        copy.exhibits.forEach((record, index) => {
            record.notes = value.exhibits[index].notes;
            record.links = value.exhibits[index].links;
        });
        return copy;
    }

    restore(value) {
        this.value = { ...value, floors: this.value.floors, assets: this.value.assets, exhibits: value.exhibits.map(record => {
            const current = this.value.exhibits.find(item => item.id === record.id);
            return { ...record, notes: current?.notes || record.notes, links: current?.links || record.links };
        }) };
    }

    change(change) {
        const next = this.copy(this.value);
        change(next);
        next.floors = this.value.floors;
        next.assets = this.value.assets;
        const content = (key, value) => ['notes', 'links'].includes(key) ? undefined : value;
        if (JSON.stringify(next, content) === JSON.stringify(this.value, content)) return false;
        this.undoStack.push(this.value);
        this.redoStack = [];
        this.value = next;
        return true;
    }

    undo() {
        if (this.undoStack.length) {
            this.redoStack.push(this.value);
            this.restore(this.undoStack.pop());
        }
    }

    redo() {
        if (this.redoStack.length) {
            this.undoStack.push(this.value);
            this.restore(this.redoStack.pop());
        }
    }

    changes() {
        const changes = [];
        for (const record of this.value.exhibits) {
            const old = this.base.exhibits.find(item => item.id === record.id);
            if (!old || JSON.stringify(structural(record)) !== JSON.stringify(structural(old))) {
                changes.push({
                    kind: 'exhibits',
                    op: 'put',
                    id: record.id,
                    record: structural(record),
                    baseRevision: old?.revision
                });
            }
        }
        for (const old of this.base.exhibits) {
            if (!this.value.exhibits.some(item => item.id === old.id)) {
                changes.push({ kind: 'exhibits', op: 'delete', id: old.id, baseRevision: old.revision });
            }
        }
        return changes;
    }
}
