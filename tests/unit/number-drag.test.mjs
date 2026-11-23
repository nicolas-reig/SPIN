import test from 'node:test';
import assert from 'node:assert/strict';
import { installNumberDrag, updateNumberFill } from '../../frontend/js/number-drag.js';

class Target {
    listeners = new Map();
    addEventListener(type, callback, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push({ callback, signal: options.signal }); this.listeners.set(type, listeners);
    }
    emit(type, event = {}) {
        event = { type, preventDefault() {}, stopImmediatePropagation() {}, ...event };
        for (const { callback, signal } of this.listeners.get(type) || []) if (!signal?.aborted) callback(event);
    }
}
class Input {
    value = '0'; focused = false; isConnected = true; captured = new Set();
    constructor(vector = 'position', relative = false) {
        this.dataset = { vector }; this.relative = relative;
        const properties = new Map();
        this.field = { style: { getPropertyValue: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, value) } };
    }
    hasAttribute() { return this.relative; }
    closest(selector) { return selector === '.axis-value' ? this.field : selector === 'input[data-vector]' ? this : null; }
    matches(selector) { return selector === ':focus' ? this.focused : selector === 'input[data-vector]'; }
    blur() { this.focused = false; this.onBlur?.(); }
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    get fill() { return parseFloat(this.field.style.getPropertyValue('--number-fill')); }
}
function setup(callbacks, input = new Input()) {
    globalThis.window = new Target(); globalThis.document = new Target();
    const classes = new Set(); document.body = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
    globalThis.getSelection = () => ({ removeAllRanges() {} });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    const root = new Target(); root.querySelectorAll = () => [input];
    const dispose = installNumberDrag(root, callbacks);
    const pointer = (type, x = 0, extra = {}) => (type === 'pointerdown' ? root : window).emit(type, {
        target: input, pointerId: 1, clientX: x, button: 0, shiftKey: false, ...extra
    });
    return { input, root, pointer, dispose, classes };
}

test('number fills track signed values and clamp visual ranges without changing editable values', () => {
    for (const [vector, relative, radius] of [['position', false, 100], ['position', true, 10], ['rotation', false, 180], ['scale', false, 2]]) {
        const input = new Input(vector, relative);
        for (const [value, fill] of [[-radius * 2, 0], [-radius, 0], [0, 50], [radius / 2, 75], [radius, 100], [radius * 2, 100]]) {
            input.value = String(value); updateNumberFill(input);
            assert.equal(input.fill, fill); assert.equal(input.value, String(value));
        }
    }
});

test('typing updates the fill immediately and incomplete negative values retain the last fill', () => {
    const { input, root, dispose } = setup({}); input.focused = true;
    input.value = '-20'; root.emit('input', { target: input }); assert.equal(input.fill, 40);
    input.value = ''; root.emit('input', { target: input }); assert.equal(input.fill, 40);
    input.value = '-40.5'; root.emit('input', { target: input }); assert.equal(input.fill, 29.75);
    input.value = ''; input.focused = false; root.emit('change', { target: input }); assert.equal(input.fill, 0);
    dispose();
});

test('dragging after typing captures the committed typed value and updates fill throughout the drag', () => {
    let stored = 10, baseline;
    const f = setup({
        start(drag) { baseline = stored; drag.initial = stored; },
        preview(drag) { drag.input.value = String(drag.initial + drag.delta); },
        commit(drag) { stored = Number(drag.input.value); },
        cancel() {}
    });
    f.input.value = '30'; f.input.focused = true; f.input.onBlur = () => { stored = Number(f.input.value); };
    f.pointer('pointerdown'); f.pointer('pointermove', 100);
    assert.equal(baseline, 30, 'blur commits typing before the drag baseline is read');
    assert.equal(f.input.value, '31'); assert.equal(f.input.fill, 65.5);
    assert.equal(f.classes.has('dragging-number'), true); assert.equal(f.input.hasPointerCapture(1), true);
    f.pointer('pointermove', 200); assert.equal(f.input.value, '32'); assert.equal(f.input.fill, 66);
    f.pointer('pointerup', 200); assert.equal(stored, 32);
    assert.equal(f.classes.has('dragging-number'), false); assert.equal(f.input.hasPointerCapture(1), false);
    f.dispose();
});

test('finishing relative transforms refreshes the fill after the control resets to its neutral value', () => {
    const f = setup({
        start() {}, preview(drag) { drag.input.value = String(drag.delta); },
        commit(drag) { drag.input.value = '0'; }, cancel() {}
    }, new Input('position', true));
    f.pointer('pointerdown'); f.pointer('pointermove', 200); assert.equal(f.input.fill, 60);
    f.pointer('pointerup', 200); assert.equal(f.input.value, '0'); assert.equal(f.input.fill, 50);
    f.dispose();
});

test('Escape restores both the value and fill and releases the drag exactly once', () => {
    let commits = 0, cancellations = 0;
    const f = setup({
        start(drag) { drag.initial = Number(drag.input.value); },
        preview(drag) { drag.input.value = String(drag.initial + drag.delta); },
        commit() { commits++; }, cancel(drag) { cancellations++; drag.input.value = String(drag.initial); }
    });
    f.input.value = '-20'; updateNumberFill(f.input);
    f.pointer('pointerdown'); f.pointer('pointermove', 100); assert.equal(f.input.fill, 40.5);
    document.emit('keydown', { key: 'Escape' }); f.pointer('pointerup', 100);
    assert.equal(f.input.value, '-20'); assert.equal(f.input.fill, 40);
    assert.equal(commits, 0); assert.equal(cancellations, 1);
    assert.equal(f.classes.has('dragging-number'), false); assert.equal(f.input.hasPointerCapture(1), false);
    f.dispose();
});

test('a blur that rebuilds the inspector abandons the detached input before starting a drag', () => {
    let starts = 0;
    const f = setup({ start() { starts++; } });
    f.input.onBlur = () => { f.input.isConnected = false; };
    f.pointer('pointerdown'); f.pointer('pointermove', 100); f.pointer('pointermove', 200); f.pointer('pointerup', 200);
    assert.equal(starts, 0); assert.equal(f.input.hasPointerCapture(1), false);
    assert.equal(f.classes.has('dragging-number'), false); f.dispose();
});

test('disabled or read-only numeric controls cannot start a drag', () => {
    for (const property of ['disabled', 'readOnly']) {
        let starts = 0;
        const f = setup({ start() { starts++; } }); f.input[property] = true;
        f.pointer('pointerdown'); f.pointer('pointermove', 100); f.pointer('pointerup', 100);
        assert.equal(starts, 0); assert.equal(f.classes.has('dragging-number'), false); f.dispose();
    }
});

test('mouse scrubbing wraps both edges and commits relative motion once on release', () => {
    let committed, cancellations = 0, requests = 0;
    const f = setup({ start() {}, preview(drag) { drag.input.value = String(drag.delta); },
        commit(drag) { committed = drag.delta; }, cancel() { cancellations++; } });
    const cursor = { style: {}, setAttribute() {}, remove() { this.removed = true; } };
    window.innerWidth = 100; window.innerHeight = 80;
    document.createElement = () => cursor;
    document.body.append = () => {};
    document.exitPointerLock = () => { document.pointerLockElement = null; document.emit('pointerlockchange'); };
    f.root.requestPointerLock = () => { requests++; };

    f.pointer('pointerdown', 90, { pointerType: 'mouse', clientY: 4 });
    f.pointer('pointerup', 90);
    assert.equal(requests, 0, 'a click can still start typing');
    f.pointer('pointerdown', 90, { pointerType: 'mouse', clientY: 4 });
    f.pointer('pointermove', 97, { clientY: 4 });
    assert.equal(requests, 1);
    document.pointerLockElement = f.root;
    f.root.emit('lostpointercapture', { pointerId: 1 });
    document.emit('pointerlockchange');
    window.emit('mousemove', { movementX: 12, movementY: -10 });
    assert.equal(cursor.style.translate, '9px 74px');
    f.pointer('pointermove', 97);
    window.emit('mousemove', { movementX: 10, movementY: 0, shiftKey: true });
    window.emit('mouseup', { button: 0 });
    f.pointer('pointerup', 97);
    assert.ok(Math.abs(committed - .2) < 1e-10);
    assert.equal(cancellations, 0);
    assert.equal(cursor.removed, true);
    assert.equal(document.pointerLockElement, null);
    f.dispose();
});

test('a lock granted after the slider finishes releases immediately', () => {
    const f = setup({ start() {}, preview() {}, commit() {}, cancel() {} });
    f.root.requestPointerLock = () => {};
    document.exitPointerLock = () => { document.pointerLockElement = null; document.emit('pointerlockchange'); };
    f.pointer('pointerdown', 0, { pointerType: 'mouse' });
    f.pointer('pointermove', 10);
    f.pointer('pointerup', 10);
    document.pointerLockElement = f.root;
    document.emit('pointerlockchange');
    assert.equal(document.pointerLockElement, null);
    f.dispose();
});
