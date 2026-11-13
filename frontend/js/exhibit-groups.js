export function exhibitGroup(name = '') {
    const separator = name.indexOf('-');
    if (separator < 1 || !name.slice(separator + 1).trim()) return '';
    return name.slice(0, separator).trim();
}

export const exhibitGroupKey = name => exhibitGroup(name).normalize('NFC').toLowerCase();

export function groupExhibits(records, language = 'en') {
    const groups = new Map();
    const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
    for (const record of records) {
        const name = exhibitGroup(record.name), key = exhibitGroupKey(record.name);
        if (!groups.has(key)) groups.set(key, { key, name, records: [] });
        groups.get(key).records.push(record);
    }
    for (const group of groups.values()) group.records.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.id, b.id));
    return [...groups.values()].sort((a, b) => !a.key ? 1 : !b.key ? -1 : collator.compare(a.name, b.name));
}

export class ExhibitGroupState {
    collapsed = new Set();
    selection = new Map();

    setOpen(key, open) {
        if (open) this.collapsed.delete(key);
        else this.collapsed.add(key);
    }

    isOpen(key, revealMatches = false) {
        return revealMatches || !this.collapsed.has(key);
    }

    reveal(records) {
        const next = new Map(records.map(record => [record.id, exhibitGroupKey(record.name)]));
        for (const [id, key] of next) if (key && this.selection.get(id) !== key) this.collapsed.delete(key);
        this.selection = next;
    }
}
