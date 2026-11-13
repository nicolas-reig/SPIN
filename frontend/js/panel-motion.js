import { SpringMotion } from './spring.js';
import { inspectorSnapshot } from './inspector-snapshot.js';

export const inspectorContext = (records, purpose = 'exhibit') => JSON.stringify([
    purpose, records.map(record => record.id).sort((a, b) => a.localeCompare(b))
]);

export class PanelMotion {
    constructor(inspector, resizer, stack = null, { sidebar = null, editbar = null, underlays = null } = {}) {
        this.inspector = inspector;
        this.stack = stack;
        this.sidebar = sidebar;
        this.underlays = underlays;
        this.snapshots = [];
        this.preparedSnapshot = null;
        this.snapshotSerial = 0;
        this.exhibits = [];
        this.layers = new Map();
        this.context = null;
        this.visibleContext = null;
        this.displayed = false;
        this.pending = false;
        this.afterEntry = null;
        this.desktop = matchMedia('(min-width: 861px)');
        this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
        this.right = new SpringMotion([inspector, resizer], {
            stiffness: 280, damping: 25, name: 'inspector-spring',
            onActivity: active => {
                inspector.classList.toggle('inspector-moving', active);
            },
            onRest: position => {
                this.clearSnapshots();
                const callback = this.afterEntry;
                this.afterEntry = null;
                if (position === 0 && this.context !== null) callback?.();
            }
        });
        this.left = new SpringMotion([sidebar, editbar].filter(Boolean), { stiffness: 480, damping: 30, name: 'sidebar-spring' });
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
            if (event.key === 'Tab' && (this.right.active || this.snapshots.length)) this.settle();
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

    enter({ fresh = false } = {}) {
        if (!this.canAnimate) { this.settle(); return; }
        const current = this.right.state();
        const initial = !fresh && this.right.active && current.position > 1 ? current : { position: this.distance, velocity: 0 };
        this.right.move(0, initial);
    }

    transition(context, exhibits) {
        if (context === this.context) return null;
        if (!context) return 'close';
        if (exhibits.some(id => !this.exhibits.includes(id)) || !this.exhibits.length || !exhibits.length) return 'enter';
        if (this.exhibits.some(id => !exhibits.includes(id))) return this.exhibits.at(-1) === exhibits.at(-1) ? 'update' : 'remove';
        return 'enter';
    }

    clearSnapshots() {
        for (const snapshot of this.snapshots) { snapshot.motion?.cancel(); snapshot.node.remove(); }
        this.snapshots = [];
        this.preparedSnapshot = null;
        if (this.removalInert !== undefined) { this.inspector.inert = this.removalInert; this.removalInert = undefined; }
        if (this.underlays) { this.underlays.hidden = true; this.underlays.classList.remove('withdrawing'); }
    }

    removeSnapshot(snapshot) {
        snapshot.motion?.cancel(); snapshot.node.remove();
        this.snapshots = this.snapshots.filter(item => item !== snapshot);
        if (this.preparedSnapshot === snapshot) this.preparedSnapshot = null;
        if (!this.snapshots.some(item => item.exiting)) {
            this.underlays.classList.remove('withdrawing');
            if (this.removalInert !== undefined) { this.inspector.inert = this.removalInert; this.removalInert = undefined; }
            if (!this.right.active) this.clearSnapshots();
        }
    }

    prepare(context, exhibits) {
        this.preparedSnapshot = null;
        const transition = this.transition(context, exhibits);
        if (!['enter', 'remove'].includes(transition) || !this.underlays || !this.displayed || !this.canAnimate || !this.inspector.getClientRects().length) return;
        const snapshot = inspectorSnapshot(this.inspector, ++this.snapshotSerial);
        snapshot.exiting = transition === 'remove';
        this.underlays.hidden = false;
        this.underlays.classList.toggle('withdrawing', transition === 'remove');
        if (transition === 'enter' && this.removalInert !== undefined) { this.inspector.inert = this.removalInert; this.removalInert = undefined; }
        const departing = this.snapshots.findIndex(item => item.exiting);
        if (departing < 0) { this.underlays.append(snapshot.node); this.snapshots.push(snapshot); }
        else { this.snapshots[departing].node.before(snapshot.node); this.snapshots.splice(departing, 0, snapshot); }
        snapshot.restoreScroll();
        this.preparedSnapshot = snapshot;
        // A rapid next selection continues the partially arrived previous panel
        // underneath the new one, instead of teleporting its content into place.
        if (this.right.active) {
            snapshot.motion = new SpringMotion([snapshot.node], { stiffness: 280, damping: 25, name: 'inspector-underlay-spring' });
            snapshot.motion.move(0, this.right.state());
        }
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

    update(context, exhibits = this.exhibits, { origin = 'other' } = {}) {
        const changed = context !== this.context;
        const transition = this.transition(context, exhibits);
        const previousExhibits = this.exhibits;
        const stackChanged = exhibits.length !== previousExhibits.length || exhibits.some((id, index) => id !== previousExhibits[index]);
        this.exhibits = [...exhibits];
        if (stackChanged) this.updateStack(exhibits);
        if (changed) this.afterEntry = null;
        const wasOpen = this.context !== null;
        this.context = context;
        if (context === null) {
            this.clearSnapshots();
            if (wasOpen) {
                if (this.displayed && this.desktop.matches && this.canAnimate) this.right.move(this.distance);
                else this.right.cancel(this.distance);
            }
            this.displayed = false;
            this.pending = false;
        } else if (!this.inspector.getClientRects().length) {
            this.afterEntry = null;
            this.right.cancel(0); this.clearSnapshots();
            this.displayed = false;
            this.pending = true;
        } else {
            if (!this.displayed || this.pending) {
                if (changed || this.visibleContext !== context) this.enter();
                else { this.right.cancel(0); this.clearSnapshots(); }
            }
            else if (changed) {
                if (transition === 'remove' && this.preparedSnapshot) {
                    this.right.cancel(0);
                    this.removalInert ??= this.inspector.inert; this.inspector.inert = true;
                    const outgoing = this.preparedSnapshot, initial = outgoing.motion?.state() || { position: 0, velocity: 0 };
                    outgoing.motion ??= new SpringMotion([outgoing.node], { stiffness: 280, damping: 25, name: 'inspector-underlay-spring' });
                    outgoing.motion.onRest = () => this.removeSnapshot(outgoing);
                    outgoing.motion.move(this.distance, initial);
                } else if (transition === 'enter') this.enter({ fresh: exhibits.length > 1 });
            }
            if (changed && origin === 'sidebar' && this.canAnimate && this.sidebar?.getClientRects().length && !this.left.active) this.left.move(0, { position: 0, velocity: 230 });
            this.displayed = true;
            this.pending = false;
            this.visibleContext = context;
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
        this.left.cancel(0); this.clearSnapshots();
        for (const layer of this.layers.values()) if (layer.animation) { layer.animation.onfinish = null; layer.animation.cancel(); layer.animation = null; }
        this.updateStack(this.exhibits, false);
        this.displayed = this.context !== null && Boolean(this.inspector.getClientRects().length);
        this.pending = this.context !== null && !this.displayed;
    }
}
