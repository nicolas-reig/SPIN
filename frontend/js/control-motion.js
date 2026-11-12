import { SpringMotion } from './spring.js';

const groups = [
    ['language', '.language'],
    ['inspector-mode', '#inspector .tabs'],
    ['camera-view', '#map-controls .view-toggle'],
    ['floor', '.floor-selector'],
    ['transform-tool', '.transform-tools']
];
const groupSelector = groups.map(([, selector]) => selector).join(',');
const popupSelector = '.floating-popover, .selection-menu';
const relevantSelector = `${groups.map(([, selector]) => selector.split(' ').at(-1)).join(',')}, .popover, .selection-menu`;
const selectedSelector = '[aria-pressed=true], [aria-selected=true], [aria-current=true]';
const key = button => button?.dataset.language || button?.dataset.tab || button?.dataset.cameraCommand || button?.dataset.floor || button?.dataset.tool || null;
const rectangle = button => ({ x: button.offsetLeft, y: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight });
const sameRect = (a, b) => a && b ? Object.keys(a).every(name => Math.abs(a[name] - b[name]) < .5) : a === b;

class ControlMotion {
    constructor() {
        this.groups = new Map();
        this.popups = new Map();
        this.pending = false;
        this.force = false;
        this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
        this.resize = new ResizeObserver(() => this.schedule());
        this.observer = new MutationObserver(records => {
            const relevant = records.some(record => {
                if (record.type === 'attributes') {
                    if (record.target === document.body && record.attributeName === 'data-view') return record.oldValue !== document.body.dataset.view;
                    return record.oldValue !== record.target.getAttribute(record.attributeName) && record.target.closest(groupSelector);
                }
                return [...record.addedNodes, ...record.removedNodes].some(node =>
                    node.nodeType === Node.ELEMENT_NODE && (node.matches(relevantSelector) || node.querySelector(relevantSelector)));
            });
            if (relevant) this.schedule();
        });
        this.observer.observe(document.body, {
            subtree: true, childList: true, attributes: true, attributeOldValue: true,
            attributeFilter: ['aria-pressed', 'aria-selected', 'aria-current', 'data-view']
        });
        this.reduced.addEventListener('change', () => this.schedule(true));
        addEventListener('resize', () => this.schedule(true));
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.schedule(true); });
        const settleMenu = event => {
            const menu = event.target.closest(popupSelector);
            this.popups.get(menu)?.cancel(1);
        };
        document.addEventListener('click', settleMenu, true);
        document.addEventListener('keydown', settleMenu, true);
        this.schedule();
    }

    get canAnimate() {
        return !this.reduced.matches && !document.hidden && typeof Element.prototype.animate === 'function';
    }

    schedule(force = false) {
        this.force ||= force;
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
            this.pending = false;
            const force = this.force;
            this.force = false;
            this.update(force);
        });
    }

    discard(state) {
        state.motion.cancel();
        this.resize.unobserve(state.element);
        state.indicator.remove();
    }

    updateGroup(name, selector, force) {
        const element = document.querySelector(selector);
        const previous = this.groups.get(name);
        if (!element) {
            if (previous) this.discard(previous);
            this.groups.delete(name);
            return;
        }
        if (element.dataset.motionGroup !== name) element.dataset.motionGroup = name;
        const buttons = [...element.querySelectorAll(':scope > button')];
        const selected = buttons.find(button => button.matches(selectedSelector));
        const value = key(selected);
        const previousValue = previous?.value;
        const rect = selected ? rectangle(selected) : null;
        const size = { width: element.clientWidth, height: element.clientHeight };
        const first = buttons[0], second = buttons[1];
        const axis = first && second && Math.abs(second.offsetTop - first.offsetTop) > Math.abs(second.offsetLeft - first.offsetLeft) ? 'y' : 'x';
        const unchanged = previous?.element === element && previous.value === value && previous.axis === axis && previous.width === size.width && previous.height === size.height && sameRect(previous.rect, rect);
        if (unchanged && !force) return;
        const moving = Boolean(previous?.motion.active);
        const sample = previous?.motion.state();
        const compatible = previous?.axis === axis && previous.width === size.width && previous.height === size.height;
        let state = previous;
        if (!state || state.element !== element) {
            if (previous) this.discard(previous);
            const indicator = document.createElement('span');
            indicator.className = 'selection-indicator';
            indicator.setAttribute('aria-hidden', 'true');
            element.append(indicator);
            state = { element, indicator, axis, rect };
            state.motion = new SpringMotion([indicator], {
                stiffness: 900, damping: 48, name: 'selection-spring',
                frame: position => ({ transform: state.axis === 'x'
                    ? `translate(${position}px, ${state.rect?.y || 0}px)`
                    : `translate(${state.rect?.x || 0}px, ${position}px)` })
            });
            this.groups.set(name, state);
            this.resize.observe(element);
        }
        state.axis = axis;
        state.rect = rect;
        state.value = value;
        Object.assign(state, size);
        state.indicator.hidden = !selected;
        if (!selected) { state.motion.cancel(0); return; }
        state.indicator.style.width = rect.width + 'px';
        state.indicator.style.height = rect.height + 'px';
        state.indicator.style.borderRadius = getComputedStyle(selected).borderRadius;
        state.indicator.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
        const priorButton = previous && buttons.find(button => key(button) === previousValue);
        const target = rect[axis];
        const initial = compatible && sample ? sample : { position: priorButton ? rectangle(priorButton)[axis] : target, velocity: 0 };
        const changed = previous && previousValue !== value;
        if (this.canAnimate && !force && previousValue && (changed || moving) && (Math.abs(initial.position - target) > .05 || Math.abs(initial.velocity) > .5)) {
            state.motion.move(target, initial);
        } else state.motion.cancel(target);
    }

    update(force) {
        for (const [name, selector] of groups) this.updateGroup(name, selector, force);
        for (const [menu, motion] of this.popups) {
            if (!menu.isConnected || !menu.matches(popupSelector)) {
                motion.cancel(1);
                this.popups.delete(menu);
            } else if (force || !this.canAnimate) motion.cancel(1);
        }
        for (const menu of document.querySelectorAll(popupSelector)) {
            if (this.popups.has(menu)) continue;
            const motion = new SpringMotion([menu], {
                stiffness: 900, damping: 48, name: 'menu-snap',
                frame: progress => ({ transform: `scale(${.975 + .025 * progress})`, opacity: Math.max(0, Math.min(1, progress)) })
            });
            this.popups.set(menu, motion);
            if (this.canAnimate && !force) motion.move(1, { position: 0, velocity: 0 });
        }
    }
}

let installed = false;
export function installControlMotion() {
    if (installed) return;
    installed = true;
    new ControlMotion();
}
