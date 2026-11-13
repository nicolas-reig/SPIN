import { SpringMotion } from './spring.js';

export const inspectorContext = (records, purpose = 'exhibit') => JSON.stringify([
    purpose, records.map(record => [record.id, record.name]).sort(([a], [b]) => a.localeCompare(b))
]);

export class PanelMotion {
    constructor(inspector, resizer, stack = null) {
        this.inspector = inspector;
        this.stack = stack;
        this.exhibits = [];
        this.layers = new Map();
        this.context = null;
        this.displayed = false;
        this.pending = false;
        this.afterEntry = null;
        this.desktop = matchMedia('(min-width: 861px)');
        this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
        this.right = new SpringMotion([inspector, resizer, ...(stack ? [stack] : [])], {
            stiffness: 280, damping: 25, name: 'inspector-spring',
            onActivity: active => {
                inspector.classList.toggle('inspector-moving', active);
            },
            onRest: position => {
                const callback = this.afterEntry;
                this.afterEntry = null;
                if (position === 0 && this.context !== null) callback?.();
            }
        });
        this.reduced.addEventListener('change', () => this.settle());
        addEventListener('resize', () => {
            if (this.context !== null) this.viewChanged();
            else if (this.right.active) {
                if (this.desktop.matches && this.canAnimate) this.right.move(this.distance);
                else this.right.cancel(this.distance);
            }
        });
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.settle(); });
        const settleForControl = event => {
            if (event.key === 'Tab' && this.right.active) this.settle();
            if ((event.type === 'click' || ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) &&
                event.target.closest('#inspector summary, #inspector [role=combobox]')) this.settle();
        };
        document.addEventListener('click', settleForControl, true);
        document.addEventListener('keydown', settleForControl, true);
    }

    get distance() {
        return (this.inspector.offsetWidth || innerWidth) + 40;
    }

    get canAnimate() {
        return !this.reduced.matches && !document.hidden && typeof this.inspector.animate === 'function';
    }

    enter() {
        if (!this.canAnimate) { this.settle(); return; }
        const current = this.right.state();
        const initial = this.right.active && current.position > 1 ? current : { position: this.distance, velocity: 0 };
        this.right.move(0, initial);
    }

    updateStack(exhibits, animate = this.canAnimate && this.desktop.matches) {
        if (!this.stack) return;
        const backing = exhibits.slice(0, -1).reverse();
        const wanted = new Set(backing);
        this.stack.hidden = !backing.length && !this.layers.size;
        const extent = backing.length ? 30 * (1 - Math.exp(-backing.length / 5)) : 0;
        this.stack.style.setProperty('--stack-extent', `${extent}px`);
        this.stack.dataset.count = String(exhibits.length);
        for (const [id, layer] of this.layers) {
            if (wanted.has(id)) continue;
            if (layer.removing && animate) continue;
            if (layer.animation) { layer.animation.onfinish = null; layer.animation.cancel(); }
            const remove = () => {
                layer.node.remove(); this.layers.delete(id);
                this.stack.hidden = this.exhibits.length < 2 && !this.layers.size;
            };
            if (!animate) remove();
            else {
                layer.removing = true;
                layer.animation = layer.node.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(8px)' }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
                layer.animation.id = 'inspector-stack-remove'; layer.animation.onfinish = remove;
            }
        }
        backing.forEach((id, rank) => {
            let layer = this.layers.get(id);
            const added = !layer;
            if (!layer) {
                const node = document.createElement('div'); node.className = 'inspector-stack-card'; node.dataset.exhibit = id;
                layer = { node }; this.layers.set(id, layer); this.stack.append(node);
            }
            if (layer.removing) { layer.animation.onfinish = null; layer.animation.cancel(); layer.removing = false; }
            const depth = 30 * (1 - Math.exp(-(rank + 1) / 5));
            layer.node.style.setProperty('--stack-depth', `${depth}px`);
            layer.node.style.setProperty('--stack-inset', `${depth * 1.2}px`);
            layer.node.style.zIndex = String(backing.length - rank);
            if (added && animate) {
                layer.animation = layer.node.animate([{ opacity: 0, transform: `translateX(${14 - depth}px)` }, { opacity: 1, transform: `translateX(${-depth}px)` }],
                    { duration: 280, delay: Math.min(rank * 28, 112), easing: 'cubic-bezier(.2,.7,.2,1)' });
                layer.animation.id = 'inspector-stack-add';
            }
        });
    }

    update(context, exhibits = this.exhibits) {
        const changed = context !== this.context;
        const previousExhibits = this.exhibits;
        const stackChanged = exhibits.length !== previousExhibits.length || exhibits.some((id, index) => id !== previousExhibits[index]);
        this.exhibits = [...exhibits];
        if (stackChanged) this.updateStack(exhibits);
        if (changed) this.afterEntry = null;
        const wasOpen = this.context !== null;
        this.context = context;
        if (context === null) {
            if (wasOpen) {
                if (this.displayed && this.desktop.matches && this.canAnimate) this.right.move(this.distance);
                else this.right.cancel(this.distance);
            }
            this.displayed = false;
            this.pending = false;
        } else if (!this.inspector.getClientRects().length) {
            this.afterEntry = null;
            this.right.cancel(0);
            this.displayed = false;
            this.pending = true;
        } else {
            if (!this.displayed || this.pending) this.enter();
            else if (changed) {
                const shared = exhibits.some(id => previousExhibits.includes(id));
                if (shared && (exhibits.length > 1 || previousExhibits.length > 1)) {
                    // New cards settle onto the existing inspector; removing a
                    // card only withdraws its backing layer, without a re-entry.
                    if (exhibits.some(id => !previousExhibits.includes(id)) && this.canAnimate) this.right.move(0, this.right.active ? this.right.state() : { position: 12, velocity: 0 });
                } else this.enter();
            }
            this.displayed = true;
            this.pending = false;
        }
        return changed && context !== null;
    }

    afterEnter(callback) {
        if (this.right.active) this.afterEntry = callback;
        else callback();
    }

    viewChanged() {
        this.update(this.context);
    }

    settle() {
        this.afterEntry = null;
        this.right.cancel(this.context === null ? this.distance : 0);
        for (const layer of this.layers.values()) if (layer.animation) { layer.animation.onfinish = null; layer.animation.cancel(); layer.animation = null; }
        this.updateStack(this.exhibits, false);
        this.displayed = this.context !== null && Boolean(this.inspector.getClientRects().length);
        this.pending = this.context !== null && !this.displayed;
    }
}
