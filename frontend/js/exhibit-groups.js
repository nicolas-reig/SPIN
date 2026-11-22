function groupSeparator(name) {
    const separator = name.indexOf('-');
    if (separator < 1 || !name.slice(0, separator).trim() || !name.slice(separator + 1).trim()) return -1;
    return separator;
}

export function exhibitGroup(name = '') {
    const separator = groupSeparator(name);
    return separator === -1 ? '' : name.slice(0, separator).trim();
}

export function exhibitNameSuffix(name) {
    const separator = groupSeparator(name);
    return separator === -1 ? name : name.slice(separator + 1).trimStart();
}

export const exhibitGroupKey = name => exhibitGroup(name).normalize('NFC').toLowerCase();
export const matchesExhibitGroup = (name, filter = null) => filter === null || exhibitGroupKey(name) === filter;

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
    filteredCollapsed = new Set();
    filter = '';
    selection = new Map();

    setFilter(filter) {
        if (this.filter === filter) return;
        this.filter = filter;
        this.filteredCollapsed.clear();
    }

    setOpen(key, open) {
        const collapsed = this.filter ? this.filteredCollapsed : this.collapsed;
        if (open) collapsed.delete(key);
        else collapsed.add(key);
    }

    isOpen(key) {
        return !(this.filter ? this.filteredCollapsed : this.collapsed).has(key);
    }

    reveal(records) {
        const next = new Map(records.map(record => [record.id, exhibitGroupKey(record.name)]));
        for (const [id, key] of next) if (key && this.selection.get(id) !== key) {
            this.collapsed.delete(key);
            this.filteredCollapsed.delete(key);
        }
        this.selection = next;
    }
}
