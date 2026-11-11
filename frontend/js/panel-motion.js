class SpringMotion {
    constructor(elements, stiffness, damping, name, onActivity = () => {}, onRest = () => {}) {
        this.elements = elements;
        this.stiffness = stiffness;
        this.decay = damping / 2;
        this.frequency = Math.sqrt(stiffness - this.decay ** 2);
        this.name = name;
        this.onActivity = onActivity;
        this.onRest = onRest;
        this.animations = [];
        this.position = 0;
        this.curve = null;
    }

    get active() {
        return this.animations.length > 0;
    }

    sample(time) {
        if (!this.curve) return { position: this.position, velocity: 0 };
        const { displacement, velocity, target } = this.curve;
        const a = displacement;
        const b = (velocity + this.decay * a) / this.frequency;
        const angle = this.frequency * time;
        const wave = a * Math.cos(angle) + b * Math.sin(angle);
        const decay = Math.exp(-this.decay * time);
        return {
            position: target + decay * wave,
            velocity: decay * (this.frequency * (b * Math.cos(angle) - a * Math.sin(angle)) - this.decay * wave)
        };
    }

    state() {
        const time = Number(this.animations[0]?.currentTime || 0) / 1000;
        if (this.curve && time >= this.curve.duration) return { position: this.curve.target, velocity: 0 };
        return this.sample(time);
    }

    move(target, initial = this.state()) {
        this.cancel(initial.position);
        this.curve = { displacement: initial.position - target, velocity: initial.velocity, target };
        const frames = [];
        let time = 0;
        // Sample the exact damped spring; transforms then run through Web Animations.
        for (let step = 0; step <= 144; step++) {
            time = step / 120;
            const state = this.sample(time);
            frames.push({ transform: `translateX(${state.position}px)`, opacity: 1, time });
            if (time > .18 && Math.abs(state.position - target) < .05 && Math.abs(state.velocity) < .5) break;
        }
        this.curve.duration = time;
        frames.at(-1).transform = `translateX(${target}px)`;
        const keyframes = frames.map(({ time: at, ...frame }) => ({ ...frame, offset: at / time }));
        this.animations = this.elements.map(element => {
            const animation = element.animate(keyframes, { duration: time * 1000, easing: 'linear', fill: 'both' });
            animation.id = this.name;
            return animation;
        });
        if (!this.animations.length) { this.cancel(target); return; }
        this.onActivity(true);
        const start = document.timeline.currentTime;
        if (start !== null) this.animations.forEach(animation => { animation.startTime = start; });
        this.animations[0].onfinish = () => { this.cancel(target); this.onRest(target); };
    }

    cancel(position = this.curve?.target ?? this.position) {
        this.animations.forEach(animation => {
            animation.onfinish = null;
            animation.cancel();
        });
        this.animations = [];
        this.curve = null;
        this.position = position;
        this.onActivity(false);
    }
}

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
        this.right = new SpringMotion([inspector, resizer], 280, 25, 'inspector-spring', active => {
            inspector.classList.toggle('inspector-moving', active);
        }, position => {
            const callback = this.afterEntry;
            this.afterEntry = null;
            if (position === 0 && this.context !== null) callback?.();
        });
        this.left = new SpringMotion([sidebar, editbar], 480, 30, 'sidebar-spring');
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
