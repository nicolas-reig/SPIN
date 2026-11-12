export const hardwareKey = ({ exhibitId, instanceIndex }) => JSON.stringify([exhibitId, instanceIndex]);

export function normalizeHardwareSelection(selection, data, floorId) {
    const seen = new Set();
    return (Array.isArray(selection) ? selection : []).filter(entry => {
        if (!entry || !Number.isInteger(entry.instanceIndex) || entry.instanceIndex < 0) return false;
        const exhibit = data.exhibits.find(record => record.id === entry.exhibitId);
        const key = hardwareKey(entry);
        if (seen.has(key) || exhibit?.floorId !== floorId || !exhibit?.models[entry.instanceIndex]) return false;
        seen.add(key); return true;
    }).map(({ exhibitId, instanceIndex }) => ({ exhibitId, instanceIndex }));
}

export function commonTransform(entries) {
    return Object.fromEntries(['position', 'rotation', 'scale'].map(key => [key, [0, 1, 2].map(axis => {
        const first = entries[0]?.transform[key][axis];
        return entries.every(entry => Math.abs(entry.transform[key][axis] - first) < 1e-8) ? first : null;
    })]));
}
