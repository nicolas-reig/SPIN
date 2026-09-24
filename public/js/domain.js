export const STATUSES = ['ok', 'problem', 'retired'];
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
export class NasDocumentLink extends Record {
    constructor(data) {
        super(data);
        const u = new URL(this.url);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('invalidUrl');
    }
}
export function validateSnapshot(s) {
    s.floors.forEach(x => new Floor(x));
    s.exhibits.forEach(x => {
        new Exhibit(x);
        if (!s.floors.some(f => f.id === x.floorId)) throw Error('invalidFloor');
        x.notes.forEach(n => new Note(n));
        x.links.forEach(n => new NasDocumentLink(n));
    });
    s.assets.forEach(x => new ModelAsset(x));
    return s;
}
export function structural(record, kind) {
    const keys = kind === 'floors' ? ['id', 'names', 'order', 'elevation', 'modelId', 'transform', 'camera'] : ['id', 'name', 'location', 'floorId', 'modelId', 'transform', 'placed'];
    return Object.fromEntries(keys.map(k => [k, structuredClone(record[k])]));
}
export class EditSession {
    constructor(snapshot) {
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
        for (const kind of ['floors', 'exhibits']) {
            for (const r of this.value[kind]) {
                const old = this.base[kind].find(x => x.id === r.id);
                if (!old && this.base.trash.some(x => x.id === r.id)) {
                    changes.push({
                        kind,
                        op: 'restore',
                        id: r.id
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
