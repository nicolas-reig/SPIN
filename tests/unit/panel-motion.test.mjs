import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelMotion, inspectorContext } from '../../frontend/js/panel-motion.js';

class Element {
    children = []; dataset = {}; calls = []; hidden = false; parent = null; offsetWidth = 360;
    classList = { toggle() {} };
    style = { setProperty(name, value) { this[name] = value; } };
    getClientRects() { return this.hidden ? [] : [{}]; }
    append(node) { this.children.push(node); node.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    animate(frames, options) {
        const animation = { frames, options, currentTime: 0, cancelled: false, onfinish: null, cancel() { this.cancelled = true; }, finish() { this.onfinish?.(); } };
        this.calls.push(animation); return animation;
    }
}
let reduced = false;
globalThis.innerWidth = 1600;
globalThis.matchMedia = query => ({ get matches() { return query.includes('reduced-motion') ? reduced : true; }, addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { hidden: false, timeline: { currentTime: 0 }, addEventListener() {}, createElement: () => new Element() };
function setup() {
    reduced = false;
    const inspector = new Element(), resizer = new Element(), stack = new Element();
    const motion = new PanelMotion(inspector, resizer, stack);
    const update = ids => motion.update(inspectorContext(ids.map(id => ({ id, name: id }))), ids);
    return { inspector, resizer, stack, motion, update };
}

test('inspector identity ignores component and field changes, but changes for another exhibit or a rename', () => {
    const a = { id: 'A', name: 'Alpha', models: [{ transform: [1, 2, 3] }] }, b = { id: 'B', name: 'Beta' };
    const key = inspectorContext([a]);
    assert.equal(inspectorContext([{ ...a, models: [{ transform: [4, 5, 6] }], hardwareSelection: [1, 2] }]), key);
    assert.equal(inspectorContext([a, b]), inspectorContext([b, a]));
    assert.notEqual(inspectorContext([b]), key);
    assert.notEqual(inspectorContext([{ ...a, name: 'Renamed' }]), key);
    assert.notEqual(inspectorContext([a], 'create'), key);
});

test('new exhibits animate only the right surfaces and repeat selections or same-exhibit updates stay still', () => {
    const { inspector, resizer, stack, motion, update } = setup();
    update(['A']); assert.equal(inspector.calls.length, 1); assert.equal(resizer.calls.length, 1); assert.equal(stack.calls.length, 1);
    assert.equal(inspector.calls[0].id, 'inspector-spring');
    inspector.calls[0].finish();
    update(['A']); motion.viewChanged();
    assert.equal(inspector.calls.length, 1);
    update(['B']); assert.equal(inspector.calls.length, 2);
    assert.equal(motion.right.elements.length, 3, 'sidebar and edit bar are not animated');
    motion.settle();
});

test('one inspector gains one decorative backing card for each additional selected exhibit', () => {
    const { inspector, stack, motion, update } = setup();
    update(['A']); motion.settle(); update(['A', 'B']);
    assert.equal(stack.children.length, 1); assert.equal(stack.children[0].dataset.exhibit, 'A');
    assert.equal(stack.hidden, false); assert.equal(stack.dataset.count, '2');
    assert.equal(motion.right.curve.displacement, 12, 'new selection settles onto the existing inspector rather than starting offscreen');
    motion.settle(); update(['A', 'B', 'C']);
    assert.equal(stack.children.length, 2);
    const a = motion.layers.get('A').node, b = motion.layers.get('B').node;
    assert.ok(parseFloat(a.style['--stack-depth']) > parseFloat(b.style['--stack-depth']), 'latest backing card is closest to the front');
    const count = inspector.calls.length;
    update(['A', 'B']);
    assert.equal(inspector.calls.length, count, 'removing an exhibit does not re-enter the inspector');
    motion.settle(); assert.equal(stack.children.length, 1);
    update(['A']); motion.settle(); assert.equal(stack.children.length, 0); assert.equal(stack.hidden, true);
});

test('rapid add, remove and re-add cancels obsolete layer removals without duplicates', () => {
    const { stack, motion, update } = setup();
    update(['A', 'B']); motion.settle(); const original = motion.layers.get('A').node;
    update(['A']); const removal = motion.layers.get('A').animation;
    update(['A', 'B']); assert.equal(removal.cancelled, true);
    removal.finish();
    assert.equal(stack.children.length, 1); assert.equal(motion.layers.get('A').node, original);
    motion.settle();
    update(Array.from({ length: 30 }, (_, index) => 'E' + index)); motion.settle();
    assert.equal(stack.children.length, 29);
    assert.ok(parseFloat(stack.style['--stack-extent']) <= 30, 'a large selection keeps a restrained edge depth');
});

test('hidden inspectors wait until visible, and reduced motion settles panels and layers immediately', () => {
    const { inspector, stack, motion, update } = setup();
    inspector.hidden = true; update(['A']); assert.equal(inspector.calls.length, 0); assert.equal(motion.pending, true);
    inspector.hidden = false; motion.viewChanged(); assert.equal(inspector.calls.length, 1);
    motion.settle(); reduced = true;
    update(['A', 'B', 'C']); assert.equal(inspector.calls.length, 1);
    assert.equal(stack.children.length, 2); assert.ok(stack.children.every(node => !node.calls.length));
    update(['A']); assert.equal(stack.children.length, 0); assert.equal(stack.hidden, true);
    motion.update(null, []); assert.equal(motion.right.active, false);
    reduced = false;
});
