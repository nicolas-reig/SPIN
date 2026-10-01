import { packEditDraft } from './draft-edit.js';

export const DRAFT_LIMIT = 128 * 1024 * 1024;
const categories = ['notes', 'links', 'dialogs', 'model', 'edit'];
const imageBlobs = new WeakMap();

export const hasNoteDraft = draft => Boolean(draft.body?.trim() || draft.signature?.trim() || draft.status ||
    draft.noteId || draft.images?.length || draft.existingImages?.length);
export const hasLinkDraft = draft => Boolean(draft.id || draft.title?.trim() || draft.url?.trim() || draft.description?.trim());

function imageBlob(image) {
    if (image.data instanceof Blob) return image.data;
    if (imageBlobs.has(image)) return imageBlobs.get(image);
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.data);
    if (!match) throw Error('invalidImage');
    const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: match[1] });
    imageBlobs.set(image, blob);
    return blob;
}

function storedValue(name, value) {
    const photos = [];
    if (name !== 'notes' || !value) return { value, photos };
    value = Object.fromEntries(Object.entries(value).map(([id, draft]) => [id, {
        ...draft, images: (draft.images || []).map(image => {
            if (image.data?.photo) return image;
            image.localId ||= image.id;
            const blob = imageBlob(image);
            photos.push({ id: image.localId, blob, bytes: blob.size });
            return { ...image, data: { photo: image.localId } };
        })
    }]));
    return { value, photos };
}

async function restoredValue(name, value) {
    if (name !== 'notes' || !value) return value;
    await Promise.all(Object.values(value).flatMap(draft => (draft.images || []).map(async image => {
        if (!(image.data instanceof Blob)) return;
        const blob = image.data;
        image.data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(Error('draftFailed'));
            reader.readAsDataURL(blob);
        });
        imageBlobs.set(image, blob);
    })));
    return value;
}

function sizeOf(value) {
    let blobs = 0;
    const text = JSON.stringify(value, (_key, item) => {
        if (!(item instanceof Blob)) return item;
        blobs += item.size;
        return { size: item.size, type: item.type, name: item.name, lastModified: item.lastModified };
    });
    return blobs + new TextEncoder().encode(text || '').length;
}

function sameValue(left, right) {
    const text = value => JSON.stringify(value, (_key, item) => item instanceof Blob
        ? { size: item.size, type: item.type, name: item.name, lastModified: item.lastModified } : item);
    return text(left) === text(right);
}

const empty = value => value == null || typeof value === 'object' && !(value instanceof Blob) && !Object.keys(value).length;
const contents = record => record?.format === 2 ? record.value : record;
const bytesOf = record => record == null ? 0 : record.format === 2 ? record.bytes : sizeOf(record);

function photoReferences(keys, values) {
    const references = new Set();
    keys.forEach((key, index) => {
        if (key[1] !== 'notes') return;
        for (const draft of Object.values(contents(values[index]) || {})) {
            for (const image of draft.images || []) {
                if (image.data?.photo) references.add(JSON.stringify([key[0], image.data.photo]));
            }
        }
    });
    return references;
}

export class DraftStore {
    constructor(dataset) {
        this.dataset = dataset;
        this.database = null;
        this.generation = 0;
        this.pending = Promise.resolve();
    }

    async open() {
        this.database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('service-hub-drafts', 3);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');
                if (!request.result.objectStoreNames.contains('meta')) request.result.createObjectStore('meta');
                if (!request.result.objectStoreNames.contains('photos')) request.result.createObjectStore('photos');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(Error('draftFailed'));
        });
        this.database.onversionchange = () => {
            this.database.close();
            this.database = null;
        };
        this.generation = await this.transaction('readonly', (_store, meta, done) => {
            const request = meta.get('generation');
            request.onsuccess = () => done(request.result || 0);
        });
        await this.cleanup();
    }

    transaction(mode, work) {
        return new Promise((resolve, reject) => {
            if (!this.database) { reject(Error('draftFailed')); return; }
            const transaction = this.database.transaction(['drafts', 'meta', 'photos'], mode);
            let result, failure;
            const fail = error => { if (failure) return; failure = error; transaction.abort(); };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => reject(failure || transaction.error || Error('draftFailed'));
            try {
                work(transaction.objectStore('drafts'), transaction.objectStore('meta'), value => { result = value; }, fail,
                    transaction.objectStore('photos'));
            } catch (error) { fail(error); }
        });
    }

    queue(work) {
        const result = this.pending.then(work);
        this.pending = result.catch(() => {});
        return result;
    }

    cleanup() {
        return this.transaction('readwrite', (store, _meta, done, fail, photos) => {
            const values = store.getAll(), keys = store.getAllKeys();
            keys.onsuccess = () => {
                try {
                    const records = new Map(keys.result.map((key, index) => [JSON.stringify(key), contents(values.result[index])]));
                    for (let index = 0; index < keys.result.length; index++) {
                        const key = keys.result[index], name = key[1], previous = values.result[index];
                        if (!categories.includes(name)) continue;
                        let value = contents(previous);
                        const notes = records.get(JSON.stringify([key[0], 'notes'])) || {};
                        const dialogs = records.get(JSON.stringify([key[0], 'dialogs'])) || {};
                        const fields = draft => Object.values(draft?.fields || {}).some(item => typeof item === 'string' ? item.trim() : item === true);
                        if (name === 'notes') value = Object.fromEntries(Object.entries(value || {}).filter(([id, draft]) =>
                            hasNoteDraft(draft) || fields(dialogs['noteLink:' + id + ':' + (draft.localId || draft.requestId)])));
                        if (name === 'links') value = Object.fromEntries(Object.entries(value || {}).filter(([_id, draft]) => hasLinkDraft(draft)));
                        if (name === 'dialogs') value = Object.fromEntries(Object.entries(value || {}).filter(([id, draft]) =>
                            (fields(draft) || draft.status) && (!id.startsWith('noteLink:') || Object.entries(notes).some(([exhibit, note]) =>
                                id === 'noteLink:' + exhibit + ':' + (note.localId || note.requestId)))));
                        if (name === 'edit') value = packEditDraft(value);
                        const prepared = storedValue(name, value);
                        for (const photo of prepared.photos) photos.put(photo, [key[0], photo.id]);
                        value = prepared.value;
                        if (empty(value)) { store.delete(key); records.delete(JSON.stringify(key)); continue; }
                        records.set(JSON.stringify(key), value);
                        if (previous?.format !== 2 || previous.updatedAt !== undefined || !sameValue(contents(previous), value)) {
                            store.put({ format: 2, value, bytes: sizeOf(value) }, key);
                        }
                    }
                    const references = photoReferences([...records.keys()].map(key => JSON.parse(key)), [...records.values()]);
                    const cursor = photos.openKeyCursor();
                    cursor.onsuccess = () => {
                        const item = cursor.result;
                        if (!item) { done(); return; }
                        if (!references.has(JSON.stringify(item.key))) photos.delete(item.key);
                        item.continue();
                    };
                } catch (error) { fail(error); }
            };
        });
    }

    async read(name) {
        await this.pending;
        const record = await this.transaction('readonly', (store, _meta, done, fail, photos) => {
            const request = store.get([this.dataset, name]);
            request.onsuccess = () => {
                const value = contents(request.result);
                const images = name === 'notes' ? Object.values(value || {}).flatMap(draft => draft.images || []).filter(image => image.data?.photo) : [];
                let pending = images.length;
                if (!pending) { done(value); return; }
                for (const image of images) {
                    const photo = photos.get([this.dataset, image.data.photo]);
                    photo.onsuccess = () => {
                        if (!(photo.result?.blob instanceof Blob)) { fail(Error('draftFailed')); return; }
                        image.data = photo.result.blob;
                        if (!--pending) done(value);
                    };
                }
            };
        });
        return restoredValue(name, record);
    }

    write(name, value) {
        if (!categories.includes(name)) return Promise.reject(Error('draftFailed'));
        let prepared;
        try { prepared = structuredClone(storedValue(name, value)); }
        catch (error) { return Promise.reject(error); }
        return this.queue(() => this.transaction('readwrite', (store, meta, done, fail, photos) => {
            const generation = meta.get('generation');
            generation.onsuccess = () => {
                if ((generation.result || 0) !== this.generation) { fail(Error('draftsChanged')); return; }
                const values = store.getAll(), keys = store.getAllKeys(), files = photos.getAll(), fileKeys = photos.getAllKeys();
                fileKeys.onsuccess = () => {
                    try {
                        const index = keys.result.findIndex(key => key[0] === this.dataset && key[1] === name);
                        const previous = values.result[index];
                        const key = [this.dataset, name];
                        const removed = empty(prepared.value);
                        const bytes = removed ? 0 : sizeOf(prepared.value);
                        const nextKeys = [...keys.result], nextValues = [...values.result];
                        if (index >= 0) nextValues[index] = removed ? null : { format: 2, value: prepared.value, bytes };
                        else { nextKeys.push(key); nextValues.push({ format: 2, value: prepared.value, bytes }); }
                        const references = photoReferences(nextKeys, nextValues);
                        const incoming = new Map(prepared.photos.map(photo => [JSON.stringify([this.dataset, photo.id]), photo]));
                        let total = nextValues.reduce((sum, record) => sum + bytesOf(record), 0);
                        files.result.forEach((file, i) => {
                            const id = JSON.stringify(fileKeys.result[i]);
                            if (references.has(id)) total += file.bytes;
                            incoming.delete(id);
                        });
                        for (const photo of incoming.values()) total += photo.bytes;
                        if (!removed && total > DRAFT_LIMIT) {
                            fail(Error('draftFull')); return;
                        }
                        files.result.forEach((_file, i) => {
                            if (!references.has(JSON.stringify(fileKeys.result[i]))) photos.delete(fileKeys.result[i]);
                        });
                        for (const [id, photo] of incoming) photos.put(photo, JSON.parse(id));
                        if (removed) store.delete(key);
                        else if (previous?.format !== 2 || !sameValue(contents(previous), prepared.value)) {
                            store.put({ format: 2, value: prepared.value, bytes }, key);
                        }
                        done();
                    } catch (error) { fail(error); }
                };
            };
        }));
    }

    stats() {
        return this.queue(() => this.transaction('readonly', (store, _meta, done, fail, photos) => {
            const request = store.getAll(), files = photos.getAll();
            files.onsuccess = () => {
                try { done({ bytes: request.result.reduce((sum, record) => sum + bytesOf(record), 0) +
                    files.result.reduce((sum, file) => sum + file.bytes, 0), limit: DRAFT_LIMIT }); }
                catch (error) { fail(error); }
            };
        }));
    }

    clear() {
        return this.queue(async () => {
            const backup = await this.transaction('readwrite', (store, meta, done, _fail, photos) => {
                const values = store.getAll(), keys = store.getAllKeys(), files = photos.getAll(), fileKeys = photos.getAllKeys(), generation = meta.get('generation');
                generation.onsuccess = () => {
                    const next = (generation.result || 0) + 1;
                    store.clear();
                    photos.clear();
                    meta.put(next, 'generation');
                    done({ entries: keys.result.map((key, index) => [key, values.result[index]]),
                        photos: fileKeys.result.map((key, index) => [key, files.result[index]]), generation: next });
                };
            });
            this.generation = backup.generation;
            return backup;
        });
    }

    restore(backup) {
        return this.queue(async () => {
            await this.transaction('readwrite', (store, meta, done, fail, photos) => {
                const count = store.count(), files = photos.count(), generation = meta.get('generation');
                generation.onsuccess = () => {
                    if (generation.result !== backup.generation || count.result || files.result) { fail(Error('draftsChanged')); return; }
                    for (const [key, value] of backup.entries) store.put(value, key);
                    for (const [key, value] of backup.photos) photos.put(value, key);
                    meta.put(backup.generation + 1, 'generation');
                    done();
                };
            });
            this.generation = backup.generation + 1;
        });
    }
}
