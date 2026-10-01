export function hasEditDraft(saved) {
    if (!saved?.base || !saved.value) return false;
    const creation = saved.creation?.record;
    return Boolean((saved.undoStack?.length || saved.redoStack?.length) || Object.values(saved.editorFields || {}).some(fields => Object.keys(fields).length) ||
        creation && (saved.creation.kind === 'exhibits' ? creation.name?.trim() :
            [creation.number, creation.de, creation.en].some(value => String(value ?? '').trim())) ||
        changes(saved.base, saved.value).length);
}

function compactSnapshot(snapshot) {
    return {
        ...snapshot,
        exhibits: snapshot.exhibits.map(({ notes, links, ...record }) => record)
    };
}

function changes(base, value) {
    const result = [];
    for (const kind of ['floors', 'exhibits']) {
        const originals = new Map(base[kind].map(record => [record.id, record]));
        for (const item of value[kind]) {
            const { notes, links, ...record } = item;
            const { notes: _notes, links: _links, ...original } = originals.get(item.id) || {};
            if (JSON.stringify(record) !== JSON.stringify(original)) result.push({ kind, id: item.id, record });
            originals.delete(item.id);
        }
        for (const id of originals.keys()) result.push({ kind, id });
    }
    return result;
}

export function packEditDraft(saved) {
    if (saved?.format === 2) return saved;
    if (!hasEditDraft(saved)) return null;
    const base = compactSnapshot(saved.base);
    return {
        ...saved, format: 2, base,
        value: changes(base, saved.value),
        undoStack: (saved.undoStack || []).map(value => changes(base, value)),
        redoStack: (saved.redoStack || []).map(value => changes(base, value)),
        editConflict: saved.editConflict ? {
            ...saved.editConflict,
            live: compactSnapshot(saved.editConflict.live),
            conflicts: saved.editConflict.conflicts.map(item => {
                if (item.field !== 'record') return item;
                const compact = value => {
                    if (!value) return value;
                    const { notes, links, ...record } = value;
                    return record;
                };
                return { ...item, current: compact(item.current), yours: compact(item.yours) };
            })
        } : null
    };
}

export function unpackEditDraft(saved, live) {
    if (!saved?.base || !saved.value) return null;
    const hydrate = value => ({
        ...value,
        exhibits: value.exhibits.map(record => {
            const current = live.exhibits.find(item => item.id === record.id);
            return { ...record, notes: current?.notes || [], links: current?.links || [] };
        })
    });
    const base = compactSnapshot(saved.base);
    const expand = patches => {
        const value = structuredClone(base);
        for (const patch of patches) {
            const index = value[patch.kind].findIndex(record => record.id === patch.id);
            if (!patch.record) { if (index >= 0) value[patch.kind].splice(index, 1); }
            else if (index < 0) value[patch.kind].push(structuredClone(patch.record));
            else value[patch.kind][index] = structuredClone(patch.record);
        }
        return hydrate(value);
    };
    return {
        ...saved, format: undefined, base: hydrate(base),
        value: saved.format === 2 ? expand(saved.value) : hydrate(saved.value),
        undoStack: (saved.undoStack || []).map(value => saved.format === 2 ? expand(value) : hydrate(value)),
        redoStack: (saved.redoStack || []).map(value => saved.format === 2 ? expand(value) : hydrate(value)),
        editConflict: saved.editConflict ? { ...saved.editConflict, live: hydrate(saved.editConflict.live) } : null
    };
}
