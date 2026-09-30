import {
    validateSnapshot
} from './domain.js';
export class Api {
    async request(url = 'api.php', options = {}) {
        let response;
        try {
            response = await fetch(url, {
                cache: 'no-store',
                ...options
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw Object.assign(Error('offline'), {
                key: 'offline'
            });
        }
        let result;
        try {
            result = await response.json();
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw Object.assign(Error('storage'), {
                key: 'storage'
            });
        }
        if (!response.ok) throw Object.assign(Error(result.error), {
            key: result.error,
            details: result.details,
            status: response.status
        });
        return result;
    }
    async load() {
        return validateSnapshot(await this.request());
    }
    async save(payload, options = {}) {
        const r = await this.request('api.php', {
            method: 'POST',
            signal: options.signal,
            headers: {
                'Content-Type': 'application/json',
                'X-Hub-Request': '1'
            },
            body: JSON.stringify(payload)
        });
        validateSnapshot(r.snapshot);
        return r;
    }
    async upload(file, kind, signature, id, dimensions = null, exhibitId = null, options = {}) {
        const f = new FormData();
        f.set('file', file);
        f.set('kind', kind);
        f.set('signature', signature);
        f.set('requestId', id);
        f.set('name', file.name);
        if (exhibitId) f.set('exhibitId', exhibitId);
        if (dimensions) f.set('dimensions', JSON.stringify(dimensions));
        return this.request('api.php', {
            method: 'POST',
            signal: options.signal,
            headers: {
                'X-Hub-Request': '1'
            },
            body: f
        });
    }
}
export const uid = () => crypto.randomUUID();
