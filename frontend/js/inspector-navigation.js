const menuKey = section => JSON.stringify(
    section.hasAttribute('data-selection-placement') ? ['selection'] :
    section.hasAttribute('data-hardware-placement') ? ['hardware', section.dataset.exhibit, section.dataset.hardwarePlacement] :
    section.hasAttribute('data-exhibit-placement') ? ['exhibit', section.dataset.exhibitPlacement] : ['menu', section.className]
);

export class InspectorNavigation {
    constructor(inspector) {
        this.inspector = inspector;
        this.selection = null;
        this.pending = null;
        this.frame = null;
    }

    capture() {
        return {
            scroll: this.inspector.querySelector('#structure-panel')?.scrollTop,
            menus: new Map([...this.inspector.querySelectorAll('details')].map(section => [menuKey(section), section.open]))
        };
    }

    reset() {
        this.selection = null;
        this.pending = null;
        cancelAnimationFrame(this.frame);
        this.frame = null;
    }

    update(exhibits, hardware, { previous = null, focus = false } = {}) {
        const selection = JSON.stringify([
            [...exhibits].sort(),
            hardware.map(entry => [entry.exhibitId, entry.instanceIndex]).sort(([a, ai], [b, bi]) => a.localeCompare(b) || ai - bi)
        ]);
        const changed = selection !== this.selection;
        this.selection = selection;
        const sections = [...this.inspector.querySelectorAll('details')];
        const panel = this.inspector.querySelector('#structure-panel');
        if (!panel) { this.reset(); return; }
        if (!changed && !focus && !this.pending && previous) {
            for (const section of sections) if (previous.menus.has(menuKey(section))) section.open = previous.menus.get(menuKey(section));
            if (previous.scroll != null) panel.scrollTop = previous.scroll;
            return;
        }
        const target = hardware.length > 1 || exhibits.size > 1
            ? sections.find(section => section.hasAttribute('data-selection-placement'))
            : hardware.length === 1
                ? sections.find(section => section.dataset.exhibit === hardware[0].exhibitId && section.dataset.hardwarePlacement === String(hardware[0].instanceIndex))
                : sections.find(section => section.dataset.exhibitPlacement === [...exhibits][0]);
        this.pending = null;
        cancelAnimationFrame(this.frame);
        this.frame = null;
        if (!target) return;
        // Keep only the selected controls and any containing disclosure open.
        for (const section of sections) section.open = section === target || section.contains(target);
        this.pending = { panel, target, anchor: target.closest('[data-hardware-card]') || target };
        this.reveal();
    }

    reveal() {
        const pending = this.pending;
        if (!pending) return;
        if (!pending.target.isConnected || !pending.target.open) { this.pending = null; return; }
        if (!pending.panel.getClientRects().length) return;
        const scroll = () => {
            const { panel, target, anchor } = pending;
            if (this.pending !== pending || !target.isConnected || !target.open || !panel.getClientRects().length) return false;
            const inset = parseFloat(getComputedStyle(panel).paddingTop) || 0;
            panel.scrollTop += anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - inset;
            return true;
        };
        scroll();
        cancelAnimationFrame(this.frame);
        // Re-align after select controls are enhanced and a mobile inspector is shown.
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            if (this.pending === pending && (scroll() || !pending.target.isConnected || !pending.target.open)) this.pending = null;
        });
    }
}
