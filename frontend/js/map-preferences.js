const key = 'hub-map-preferences';

export function readMapPreferences() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(key)); } catch {}
    return { topCircle: stored?.topCircle === true, groupLabels: stored?.groupLabels === true };
}

export function saveMapPreferences(preferences) {
    try {
        localStorage.setItem(key, JSON.stringify(preferences));
        return true;
    } catch { return false; }
}
