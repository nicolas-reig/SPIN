import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelMotion, inspectorContext } from '../../frontend/js/panel-motion.js';
import { inspectorSnapshot } from '../../frontend/js/inspector-snapshot.js';

class Element {
    children = []; dataset = {}; calls = []; hidden = false; parent = null; offsetWidth = 360;
    id = ''; textContent = ''; attrs = new Map(); scrollTop = 0; scrollLeft = 0; inert = false; className = '';
    classList = {
        add: name => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); },
        remove: name => { this.className = this.className.split(' ').filter(value => value && value !== name).join(' '); },
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, force) => { if (force ?? !this.classList.contains(name)) this.classList.add(name); else this.classList.remove(name); }
    };
    style = { setProperty(name, value) { this[name] = value; } };
    getClientRects() { return this.hidden ? [] : [{}]; }
    append(node) { this.children.push(node); node.parent = this; }
    before(node) { const parent = this.parent; parent.children.splice(parent.children.indexOf(this), 0, node); node.parent = parent; }
    querySelectorAll() { return this.children.flatMap(node => [node, ...node.querySelectorAll('*')]); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) { this.attrs.set(name, value); }
    removeAttribute(name) { this.attrs.delete(name); }
    cloneNode(deep) {
        const copy = new Element(); copy.id = this.id; copy.textContent = this.textContent; copy.attrs = new Map(this.attrs); copy.dataset = { ...this.dataset }; copy.className = this.className;
        if ('value' in this) copy.value = this.defaultValue;
        if ('checked' in this) copy.checked = false;
        if ('selected' in this) copy.selected = false;
        if (deep) for (const node of this.children) copy.append(node.cloneNode(true));
        return copy;
    }
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
globalThis.getComputedStyle = element => ({ transform: element.style.transform || 'matrix(1, 0, 0, 1, -12, 0)', opacity: '.8', top: '8px', bottom: '8px' });
function setup() {
    reduced = false;
    const inspector = new Element(), resizer = new Element(), stack = new Element(), sidebar = new Element(), editbar = new Element(), underlays = new Element();
    inspector.id = 'inspector';
    const motion = new PanelMotion(inspector, resizer, stack, { sidebar, editbar, underlays });
    const update = (ids, options = {}) => {
        const context = inspectorContext(ids.map(id => ({ id, name: id })));
        motion.prepare(context, ids, options); inspector.textContent = ids.join(',');
        return motion.update(context, ids, options);
    };
    return { inspector, resizer, stack, sidebar, editbar, underlays, motion, update };
}

test('inspector identity ignores component, field and name changes and changes only for another exhibit or purpose', () => {
    const a = { id: 'A', name: 'Alpha', models: [{ transform: [1, 2, 3] }] }, b = { id: 'B', name: 'Beta' };
    const key = inspectorContext([a]);
    assert.equal(inspectorContext([{ ...a, models: [{ transform: [4, 5, 6] }], hardwareSelection: [1, 2] }]), key);
    assert.equal(inspectorContext([a, b]), inspectorContext([b, a]));
    assert.notEqual(inspectorContext([b]), key);
    assert.equal(inspectorContext([{ ...a, name: 'Renamed' }]), key);
    assert.notEqual(inspectorContext([a], 'create'), key);
});

test('original R spring runs for exhibit changes, while original L spring is restricted to sidebar actions', () => {
    const { inspector, resizer, sidebar, editbar, motion, update } = setup();
    update(['A'], { origin: 'sidebar' }); assert.equal(inspector.calls.length, 1); assert.equal(resizer.calls.length, 1);
    assert.equal(inspector.calls[0].id, 'inspector-spring');
    assert.equal(motion.right.stiffness, 280); assert.equal(motion.right.decay, 12.5);
    assert.equal(motion.left.stiffness, 480); assert.equal(motion.left.decay, 15);
    assert.equal(motion.left.curve.velocity, 230);
    assert.equal(sidebar.calls[0].id, 'sidebar-spring'); assert.equal(editbar.calls.length, 1);
    motion.settle();
    update(['A'], { origin: 'sidebar' }); motion.viewChanged();
    assert.equal(inspector.calls.length, 1);
    assert.equal(sidebar.calls.length, 1);
    update(['B'], { origin: 'viewport' }); assert.equal(inspector.calls.length, 2); assert.equal(sidebar.calls.length, 1);
    motion.settle(); update(['C'], { origin: 'inspector' }); assert.equal(inspector.calls.length, 3); assert.equal(sidebar.calls.length, 1);
    motion.settle();
});

test('one inspector gains one decorative backing card for each additional selected exhibit', () => {
    const { inspector, stack, motion, update } = setup();
    update(['A']); motion.settle(); update(['A', 'B']);
    assert.equal(stack.children.length, 1); assert.equal(stack.children[0].dataset.exhibit, 'A');
    assert.equal(stack.hidden, false); assert.equal(stack.dataset.count, '2');
    assert.equal(motion.right.curve.displacement, motion.distance, 'new top panel uses the original full R slide');
    motion.settle(); update(['A', 'B', 'C']);
    assert.equal(stack.children.length, 2);
    const a = motion.layers.get('A').node, b = motion.layers.get('B').node;
    assert.ok(parseFloat(a.style['--stack-depth']) > parseFloat(b.style['--stack-depth']), 'latest backing card is closest to the front');
    const count = inspector.calls.length;
    update(['A', 'B']);
    assert.equal(inspector.calls.length, count, 'removing an exhibit does not re-enter the inspector');
    assert.equal(motion.snapshots.at(-1).motion.curve.target, motion.distance, 'top panel withdraws to reveal its predecessor');
    motion.settle(); assert.equal(stack.children.length, 1);
    update(['A']); motion.settle(); assert.equal(stack.children.length, 0); assert.equal(stack.hidden, true);
});

test('stack additions suppress duplicate underlay shadows and restore the single-panel shadow after retraction', () => {
    const { inspector, motion, update } = setup();
    update(['A']); motion.settle();
    assert.equal(inspector.classList.contains('inspector-stacked'), false);
    update(['A', 'B']);
    assert.equal(inspector.classList.contains('inspector-stacked'), true);
    assert.equal(motion.preparedSnapshot.node.classList.contains('inspector-under-stack'), true);
    motion.settle(); update(['C']);
    assert.equal(inspector.classList.contains('inspector-stacked'), false);
    assert.equal(motion.preparedSnapshot.node.classList.contains('inspector-stacked'), true, 'the retiring stack retains its own depth styling');
    assert.equal(motion.preparedSnapshot.node.classList.contains('inspector-under-stack'), false, 'a fresh single selection retains the separate spring retraction');
    motion.settle();
});

test('opening exhibit creation from the sidebar brings in the populated new view with R and L', () => {
    const { inspector, sidebar, motion, update } = setup();
    update(['A']); motion.settle();
    const context = inspectorContext([], 'create');
    motion.prepare(context, []); inspector.textContent = 'New exhibit'; motion.update(context, [], { origin: 'sidebar' });
    assert.equal(motion.right.curve.displacement, motion.distance);
    assert.equal(motion.right.curve.target, 0); assert.equal(sidebar.calls.length, 1);
    assert.equal(motion.snapshots[0].node.textContent, 'A'); assert.equal(motion.snapshots[0].exiting, false);
    motion.settle();
});

test('incoming panels have their new content while the previous inspector remains rendered underneath until covered', () => {
    const { inspector, sidebar, underlays, motion, update } = setup();
    update(['A']); motion.settle();
    inspector.scrollTop = 140;
    update(['A', 'B'], { origin: 'sidebar' });
    assert.equal(sidebar.calls.length, 1);
    assert.equal(inspector.textContent, 'A,B');
    assert.equal(underlays.hidden, false); assert.equal(motion.snapshots[0].node.textContent, 'A');
    assert.equal(motion.snapshots[0].node.scrollTop, 140);
    assert.equal(motion.snapshots[0].node.inert, true);
    inspector.calls.at(-1).currentTime = 90;
    update(['A', 'B', 'C'], { origin: 'viewport' });
    assert.equal(sidebar.calls.length, 1, 'viewport stack additions do not trigger L');
    assert.equal(motion.snapshots.length, 2);
    assert.equal(motion.snapshots[1].node.textContent, 'A,B');
    assert.ok(motion.snapshots[1].motion.active, 'interrupted prior panel continues its original spring underneath');
    assert.equal(inspector.textContent, 'A,B,C');
    inspector.calls.at(-1).finish();
    assert.equal(motion.snapshots.length, 0); assert.equal(underlays.hidden, true);
});

test('changing a single selection retracts the old populated panel beneath a fresh incoming spring', () => {
    const { inspector, underlays, motion, update } = setup();
    update(['A']); motion.settle(); inspector.scrollTop = 240;
    update(['B'], { origin: 'viewport' });
    const outgoing = motion.preparedSnapshot;
    assert.equal(inspector.textContent, 'B'); assert.equal(outgoing.node.textContent, 'A');
    assert.equal(outgoing.node.scrollTop, 240); assert.equal(outgoing.exiting, false);
    assert.equal(outgoing.motion.name, 'inspector-retract-spring');
    assert.equal(outgoing.motion.stiffness, motion.right.stiffness); assert.equal(outgoing.motion.decay, motion.right.decay);
    assert.equal(outgoing.motion.curve.target, motion.distance);
    assert.equal(outgoing.motion.sample(0).position, 0);
    assert.equal(motion.right.sample(0).position, motion.distance);
    assert.ok(outgoing.motion.sample(.08).position > 0, 'the old panel swipes toward the right edge');
    assert.ok(motion.right.sample(.08).position < motion.distance, 'the new panel simultaneously slides over it');
    assert.equal(outgoing.surface.calls[0].startTime, inspector.calls.at(-1).startTime);
    inspector.calls.at(-1).finish();
    assert.equal(outgoing.node.parent, null); assert.equal(underlays.hidden, true);
});

test('starting a fresh selection retracts the previous stack borders together with its populated inspector', () => {
    const { inspector, stack, underlays, motion, update } = setup();
    update(['A', 'B', 'C']); motion.settle();
    const oldLayers = [...motion.layers.values()].map(layer => layer.node);
    update(['D']);
    const outgoing = motion.preparedSnapshot;
    assert.equal(outgoing.node.textContent, 'A,B,C'); assert.equal(inspector.textContent, 'D');
    assert.equal(outgoing.stack.children.length, 2); assert.equal(outgoing.stack.id, '');
    assert.equal(outgoing.stack.children[0].style.transform, 'matrix(1, 0, 0, 1, -12, 0)');
    assert.equal(outgoing.stack.children[0].style.opacity, '.8'); assert.equal(outgoing.stack.children[0].style.transition, 'none');
    assert.deepEqual(outgoing.surface.children, [outgoing.stack, outgoing.node]);
    assert.deepEqual(outgoing.motion.elements, [outgoing.surface]);
    assert.equal(outgoing.surface.calls[0].startTime, inspector.calls.at(-1).startTime);
    assert.equal(stack.children.length, 0); assert.equal(motion.layers.size, 0);
    assert.ok(oldLayers.every(node => !node.parent), 'old canonical borders yield to the single retracting copy');
    assert.equal(inspector.inert, false, 'the incoming view stays above the outgoing stack');
    motion.settle();
    assert.equal(outgoing.stack.parent, null); assert.equal(underlays.children.length, 0);
});

test('selecting one existing stack member afresh differs from removing another member with Shift', () => {
    const { inspector, motion, update } = setup();
    update(['A', 'B', 'C']); motion.settle();
    let count = inspector.calls.length;
    update(['A', 'B']);
    assert.equal(inspector.calls.length, count, 'ordinary deselection preserves the existing top-withdrawal behavior');
    assert.equal(motion.preparedSnapshot.exiting, true);
    motion.settle();
    update(['B'], { replace: true });
    assert.equal(inspector.calls.length, count + 1, 'a fresh selection gets a new full incoming slide even for the same front owner');
    assert.equal(motion.preparedSnapshot.exiting, false); assert.ok(motion.preparedSnapshot.stack);
    assert.equal(motion.right.sample(0).position, motion.distance);
    motion.settle(); update(['A', 'B', 'C']); motion.settle(); count = inspector.calls.length;
    update(['A'], { replace: true });
    assert.equal(inspector.calls.length, count + 1, 'isolating a backing member also replaces the whole previous stack');
    assert.equal(motion.preparedSnapshot.motion.name, 'inspector-retract-spring');
    motion.settle();
});

test('rapid fresh selections preserve the interrupted panel position and velocity beneath a fully new incoming panel', () => {
    const { inspector, motion, update } = setup();
    update(['A']); motion.settle(); update(['B']);
    const a = motion.preparedSnapshot;
    inspector.calls.at(-1).currentTime = 90;
    const interrupted = motion.right.state();
    update(['C']); const b = motion.preparedSnapshot;
    assert.deepEqual(motion.snapshots.map(snapshot => snapshot.node.textContent), ['A', 'B']);
    assert.equal(b.motion.sample(0).position + b.arrival.sample(0).position, interrupted.position);
    assert.ok(Math.abs(b.arrival.sample(0).velocity - interrupted.velocity) < 1e-9);
    assert.equal(motion.right.sample(0).position, motion.distance);
    assert.equal(a.motion.active, true, 'the first retracting view continues without a jump');
    inspector.calls.at(-1).finish(); assert.equal(motion.snapshots.length, 0);
});

test('outgoing inspector copies live form values and scroll offsets without duplicate IDs or focusable controls', () => {
    const root = new Element(), field = new Element(), label = new Element(); root.id = 'inspector'; field.id = 'position';
    field.value = '6.123456'; field.defaultValue = '0'; field.checked = true; field.setAttribute('autofocus', ''); label.setAttribute('for', 'position');
    root.append(label); root.append(field); root.scrollTop = 230;
    const snapshot = inspectorSnapshot(root, 7); snapshot.restoreScroll();
    assert.equal(snapshot.node.id, 'inspector-snapshot-7-inspector');
    assert.equal(snapshot.node.children[1].value, field.value); assert.equal(snapshot.node.children[1].checked, true);
    assert.equal(snapshot.node.children[1].getAttribute('autofocus'), null);
    assert.equal(snapshot.node.children[0].getAttribute('for'), snapshot.node.children[1].id);
    assert.equal(snapshot.node.children[1].dataset.snapshotId, 'position'); assert.equal(snapshot.node.scrollTop, 230);
    assert.equal(snapshot.node.getAttribute('aria-hidden'), 'true'); assert.equal(snapshot.node.inert, true);
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

test('rapidly removing stacked top panels preserves each departing view until its own spring finishes', () => {
    const { inspector, underlays, motion, update } = setup();
    update(['A', 'B', 'C']); motion.settle();
    update(['A', 'B']); const newest = motion.preparedSnapshot;
    update(['A']); const previous = motion.preparedSnapshot;
    assert.deepEqual(underlays.children.map(node => node.textContent), ['A,B', 'A,B,C']);
    assert.equal(inspector.inert, true);
    newest.node.calls.at(-1).finish();
    assert.equal(motion.snapshots.length, 1); assert.equal(motion.snapshots[0], previous);
    assert.equal(underlays.hidden, false); assert.equal(inspector.inert, true);
    previous.node.calls.at(-1).finish();
    assert.equal(motion.snapshots.length, 0); assert.equal(inspector.inert, false);
});

test('hidden inspectors wait until visible, and reduced motion settles panels and layers immediately', () => {
    const { inspector, stack, motion, update } = setup();
    inspector.hidden = true; update(['A']); assert.equal(inspector.calls.length, 0); assert.equal(motion.pending, true);
    inspector.hidden = false; motion.viewChanged(); assert.equal(inspector.calls.length, 1);
    motion.settle(); inspector.hidden = true; motion.viewChanged(); inspector.hidden = false; motion.viewChanged();
    assert.equal(inspector.calls.length, 1, 'revealing the same exhibit does not restart R');
    reduced = true;
    update(['A', 'B', 'C']); assert.equal(inspector.calls.length, 1);
    assert.equal(stack.children.length, 2); assert.ok(stack.children.every(node => !node.calls.length));
    update(['A']); assert.equal(stack.children.length, 0); assert.equal(stack.hidden, true);
    update(['D']); assert.equal(inspector.calls.length, 1); assert.equal(motion.snapshots.length, 0);
    motion.update(null, []); assert.equal(motion.right.active, false);
    reduced = false;
});
