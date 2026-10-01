export class DraftStore {
    constructor(dataset) {
        this.dataset = dataset;
        this.database = null;
    }

    async open() {
        this.database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('service-hub-drafts', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(Error('draftFailed'));
        });
        this.database.onversionchange = () => {
            this.database.close();
            this.database = null;
        };
    }

    read(name) {
        return new Promise((resolve, reject) => {
            if (!this.database) { reject(Error('draftFailed')); return; }
            const transaction = this.database.transaction('drafts', 'readonly');
            const request = transaction.objectStore('drafts').get([this.dataset, name]);
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = () => reject(transaction.error || Error('draftFailed'));
        });
    }

    write(name, value) {
        return new Promise((resolve, reject) => {
            if (!this.database) { reject(Error('draftFailed')); return; }
            const transaction = this.database.transaction('drafts', 'readwrite');
            const store = transaction.objectStore('drafts');
            const key = [this.dataset, name];
            if (value == null) store.delete(key);
            else store.put(value, key);
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || Error('draftFailed'));
        });
    }
}
