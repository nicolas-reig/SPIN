export const hardwareKey = ({ exhibitId, instanceIndex }) => JSON.stringify([exhibitId, instanceIndex]);

export function hardwareSelected(exhibitId, instanceIndex, exhibits, hardware) {
    return hardware.length ? hardware.some(entry => entry.exhibitId === exhibitId && entry.instanceIndex === instanceIndex) : exhibits.has(exhibitId);
}

export function expandExhibitSelection(exhibits, data, floorId) {
    return data.exhibits.filter(record => exhibits.has(record.id) && record.floorId === floorId)
        .flatMap(record => record.models.map((_, instanceIndex) => ({ exhibitId: record.id, instanceIndex })));
}

export function wholeHardwareSelection(exhibits, hardware, data) {
    if (!hardware.length || !exhibits.size) return hardware;
    const keys = new Set(hardware.map(hardwareKey));
    return [...exhibits].every(id => {
        const record = data.exhibits.find(record => record.id === id);
        return record?.models.length && record.models.every((_, instanceIndex) => keys.has(hardwareKey({ exhibitId: id, instanceIndex })));
    }) ? [] : hardware;
}

export function pickHardwareSelection(exhibits, hardware, data, floorId, { exhibitId, instanceIndex, extend = false, viewport = false }) {
    const record = data.exhibits.find(record => record.id === exhibitId);
    if (!record?.models[instanceIndex]) return null;
    const whole = viewport && !exhibits.has(exhibitId);
    const canExtend = extend && record.floorId === floorId;
    let entries = canExtend ? hardware.length ? [...hardware] : expandExhibitSelection(exhibits, data, floorId) : [];
    const entry = { exhibitId, instanceIndex };
    if (whole) entries.push(...record.models.map((_, instanceIndex) => ({ exhibitId, instanceIndex })));
    else if (!canExtend) entries = [entry];
    else if (entries.some(item => hardwareKey(item) === hardwareKey(entry))) entries = entries.filter(item => hardwareKey(item) !== hardwareKey(entry));
    else entries.push(entry);
    const owners = new Set(entries.map(entry => entry.exhibitId));
    return { exhibits: owners, hardware: wholeHardwareSelection(owners, entries, data) };
}

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
