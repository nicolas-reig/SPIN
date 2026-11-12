export class SpringMotion {
    constructor(elements, { stiffness, damping, name, onActivity = () => {}, onRest = () => {}, frame = position => ({ transform: `translateX(${position}px)`, opacity: 1 }) }) {
        this.elements = elements;
        this.stiffness = stiffness;
        this.decay = damping / 2;
        this.frequency = Math.sqrt(stiffness - this.decay ** 2);
        this.name = name;
        this.onActivity = onActivity;
        this.onRest = onRest;
        this.frame = frame;
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
            frames.push({ ...this.frame(state.position), time });
            if (time > .18 && Math.abs(state.position - target) < .05 && Math.abs(state.velocity) < .5) break;
        }
        this.curve.duration = time;
        frames[frames.length - 1] = { ...this.frame(target), time };
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
