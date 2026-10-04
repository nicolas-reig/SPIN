const preferenceKey = 'hub-signature';
const lifetime = 10 * 24 * 60 * 60 * 1000;

export function rememberedSignature() {
    try {
        const raw = localStorage.getItem(preferenceKey);
        if (raw === null) return '';
        const saved = JSON.parse(raw);
        const now = Date.now();
        if (typeof saved?.value === 'string' && saved.value.trim() && saved.value.length <= 120 &&
            Number.isFinite(saved.expiresAt) && saved.expiresAt > now && saved.expiresAt <= now + lifetime) {
            return saved.value.trim();
        }
    } catch {}
    try { localStorage.removeItem(preferenceKey); } catch {}
    return '';
}

export function rememberSignature(value) {
    if (typeof value !== 'string') return false;
    value = value.trim();
    if (!value || value.length > 120) return false;
    try {
        localStorage.setItem(preferenceKey, JSON.stringify({ value, expiresAt: Date.now() + lifetime }));
        return true;
    } catch {
        return false;
    }
}

rememberedSignature();
