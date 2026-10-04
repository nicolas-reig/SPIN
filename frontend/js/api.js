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
    async postNote(payload, images) {
        const form = new FormData();
        const attachments = [];
        for (const [index, image] of images.entries()) {
            const blob = await (await fetch(image.data)).blob();
            const field = 'photo_' + index;
            form.set(field, new File([blob], image.name, { type: blob.type }));
            attachments.push({ field, requestId: image.id });
        }
        form.set('payload', JSON.stringify({ ...payload, attachments }));
        const result = await this.request('api.php', {
            method: 'POST', headers: { 'X-Hub-Request': '1' }, body: form
        });
        validateSnapshot(result.snapshot);
        return result;
    }
}
export function uid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
