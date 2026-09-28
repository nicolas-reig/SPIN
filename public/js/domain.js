export const STATUSES = ['ok', 'problem', 'retired'];
export const STATUS_COLORS = { ok: '#31975c', problem: '#d99a22', retired: '#798491' };
export const SELECTION_COLORS = { normal: '#1684ef', edit: '#8056cb' };
export const identity = () => ({
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1]
});
const finite = n => typeof n === 'number' && Number.isFinite(n);
export class MapPlacement {
    constructor(data = identity()) {
        for (const k of ['position', 'rotation', 'scale']) {
            if (!Array.isArray(data[k]) || data[k].length !== 3 || !data[k].every(finite)) throw Error('invalidTransform');
            this[k] = [...data[k]];
        }
        if (this.scale.some(x => x <= 0)) throw Error('invalidTransform');
    }
    dimensions(bounds) {
        return bounds.map((v, i) => v * this.scale[i]);
    }
    resize(bounds, axis, size, locked = true) {
        if (bounds[axis] <= 0 || size <= 0) throw Error('invalidTransform');
        const scale = size / bounds[axis];
        if (locked) this.scale = this.scale.map(v => v * scale / this.scale[axis]);
        else this.scale[axis] = scale;
        return this;
    }
    toJSON() {
        return {
            position: [...this.position],
            rotation: [...this.rotation],
            scale: [...this.scale]
        };
    }
}
export class Location {
    constructor(floorId, label = '') {
        this.floorId = floorId;
        this.label = label;
    }
}
class Record {
    constructor(data) {
        if (!data?.id || !/^[-\w]+$/.test(data.id)) throw Error('invalidId');
        Object.assign(this, structuredClone(data));
    }
    toJSON() {
        return {
            ...this
        };
    }
}
export class Exhibit extends Record {
    constructor(data) {
        super(data);
        if (!STATUSES.includes(this.status)) throw Error('invalidStatus');
        new MapPlacement(this.transform);
    }
    get locationValue() {
        return new Location(this.floorId, this.location);
    }
}
export class Floor extends Record {
    constructor(data) {
        super(data);
        new MapPlacement(this.transform);
        if (!this.names?.de || !this.names?.en || !this.modelId) throw Error('invalidFloor');
    }
}
export class ModelAsset extends Record {
    constructor(data) {
        super(data);
        if (!this.dimensions?.every(finite)) throw Error('invalidModel');
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
        return ['http:', 'https:', 'smb:', 'file:', 'ftp:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value) && (url.hostname || url.protocol === 'file:');
    } catch { return false; }
}
export class NasDocumentLink extends Record {
    constructor(data) {
        super(data);
        if (!safeUrl(this.url)) throw Error('invalidUrl');
    }
}
export function validateViews(views = {}, required = false) {
    for (const key of ['top', 'three']) {
        const view = views[key];
        if (!view) { if (required) throw Error('invalidView'); else continue; }
        if (![view.position, view.target].every(vector => Array.isArray(vector) && vector.length === 3 && vector.every(finite)) || !finite(view.span) || view.span <= 0) throw Error('invalidView');
    }
}
export function validateSnapshot(s) {
    s.areas ||= [];
    s.areas.forEach(area => { if (!area.name || !s.floors.some(f => f.id === area.floorId)) throw Error('invalidArea'); validateViews(area.views, true); });
    s.floors.forEach(x => new Floor(x));
    s.exhibits.forEach(x => {
        x.areaIds ||= [];
        x.views ||= {};
        validateViews(x.views);
        if (x.areaIds.some(id => !s.areas.some(area => area.id === id && area.floorId === x.floorId))) throw Error('invalidArea');
        new Exhibit(x);
        if (!s.floors.some(f => f.id === x.floorId)) throw Error('invalidFloor');
        x.notes.forEach(n => new Note(n));
        x.links.forEach(n => new NasDocumentLink(n));
    });
    s.assets.forEach(x => new ModelAsset(x));
    return s;
}
export function structural(record, kind) {
    const keys = kind === 'areas' ? ['id', 'name', 'floorId', 'views'] : kind === 'floors' ? ['id', 'names', 'order', 'elevation', 'modelId', 'transform', 'camera'] : ['id', 'name', 'location', 'floorId', 'modelId', 'transform', 'placed', 'status', 'areaIds', 'views'];
    return Object.fromEntries(keys.map(k => [k, structuredClone(record[k] ?? (k === 'areaIds' ? [] : k === 'views' ? {} : null))]));
}
export class EditSession {
    constructor(snapshot) {
        snapshot = { ...snapshot, areas: snapshot.areas || [] };
        this.base = structuredClone(snapshot);
        this.value = structuredClone(snapshot);
        this.undoStack = [];
        this.redoStack = [];
    }
    change(fn) {
        this.undoStack.push(structuredClone(this.value));
        this.redoStack = [];
        fn(this.value);
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
        for (const kind of ['floors', 'areas', 'exhibits']) {
            for (const r of this.value[kind]) {
                const old = this.base[kind].find(x => x.id === r.id);
                if (!old && this.base.trash.some(x => x.id === r.id)) {
                    changes.push({
                        kind,
                        op: 'restore',
                        id: r.id,
                        record: structural(r, kind)
                    });
                    continue;
                }
                if (!old || JSON.stringify(structural(r, kind)) !== JSON.stringify(structural(old, kind))) changes.push({
                    kind,
                    op: 'put',
                    id: r.id,
                    record: structural(r, kind),
                    baseRevision: old?.revision,
                    status: r.status
                });
            }
            for (const old of this.base[kind])
                if (!this.value[kind].some(r => r.id === old.id)) changes.push({
                    kind,
                    op: 'delete',
                    id: old.id,
                    baseRevision: old.revision
                });
        }
        return changes;
    }
}
