import { SpringMotion } from './spring.js';

export class PanelMotion {
    constructor(inspector, resizer, sidebar, editbar) {
        this.inspector = inspector;
        this.sidebar = sidebar;
        this.context = null;
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
                const callback = this.afterEntry;
                this.afterEntry = null;
                if (position === 0 && this.context !== null) callback?.();
            }
        });
        this.left = new SpringMotion([sidebar, editbar], { stiffness: 480, damping: 30, name: 'sidebar-spring' });
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
        if (this.sidebar.getClientRects().length && !this.left.active) {
            this.left.move(0, { position: 0, velocity: 230 });
        }
    }

    update(context) {
        const changed = context !== this.context;
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
            if (changed || !this.displayed || this.pending) this.enter();
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
        this.left.cancel(0);
        this.displayed = this.context !== null && Boolean(this.inspector.getClientRects().length);
        this.pending = this.context !== null && !this.displayed;
    }
}
