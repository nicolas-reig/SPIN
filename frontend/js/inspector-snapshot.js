// A brief, inert rendering of the outgoing inspector. Live form values and
// scroll positions matter here: cloneNode alone retains default field values.
export function inspectorSnapshot(inspector, serial) {
    const snapshot = inspector.cloneNode(true);
    const originals = [inspector, ...inspector.querySelectorAll('*')];
    const copies = [snapshot, ...snapshot.querySelectorAll('*')];
    const ids = new Map();
    copies.forEach((copy, index) => {
        const original = originals[index];
        if ('value' in original && original.type !== 'file') copy.value = original.value;
        if ('checked' in original) copy.checked = original.checked;
        if ('selected' in original) copy.selected = original.selected;
        copy.removeAttribute('autofocus');
        if (copy.id) {
            const id = copy.id, replacement = `inspector-snapshot-${serial}-${id}`;
            copy.dataset.snapshotId = id; copy.id = replacement; ids.set(id, replacement);
        }
    });
    for (const copy of copies) {
        for (const attribute of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
            const value = copy.getAttribute(attribute);
            if (value) copy.setAttribute(attribute, value.split(/\s+/).map(id => ids.get(id) || id).join(' '));
        }
    }
    snapshot.classList.add('inspector-outgoing'); snapshot.classList.remove('inspector-moving');
    snapshot.setAttribute('aria-hidden', 'true'); snapshot.inert = true;
    return { node: snapshot, restoreScroll() {
        copies.forEach((copy, index) => { copy.scrollTop = originals[index].scrollTop; copy.scrollLeft = originals[index].scrollLeft; });
    } };
}
