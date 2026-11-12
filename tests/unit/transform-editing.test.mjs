import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { TransformInput, numericValue } from '../../frontend/js/transform-input.js';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return specifier === 'three' ? { url: new URL('../../frontend/vendor/three/build/three.webgpu.js', import.meta.url).href, shortCircuit: true } : nextResolve(specifier, context);
    }
});
const { BoxGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } = await import('three');
const { geometryCenter, selectionCenter, TransformTransaction, transformDelta, selectionFieldDelta } = await import('../../frontend/js/transform-math.js');

const near = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-8, `${actual} != ${expected}`));
function fixture() {
    const parent = new Group();
    parent.position.set(5, 1, -3);
    parent.rotation.y = .37;
    parent.scale.setScalar(2);
    const holder = new Group();
    holder.position.set(2, 0, 1);
    parent.add(holder);
    const mesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
    mesh.position.set(20, 3, -10);
    holder.add(mesh);
    parent.updateMatrixWorld(true);
    return { parent, holder, mesh, entry: { exhibitId: 'Exhibit', instanceIndex: 0, object: holder } };
}

test('transform pivot follows displaced geometry and the median of selected geometry centers', () => {
    const { parent, holder, mesh, entry } = fixture();
    near(geometryCenter(holder).toArray(), mesh.getWorldPosition(new Vector3()).toArray());
    assert.ok(geometryCenter(holder).distanceTo(holder.getWorldPosition(new Vector3())) > 10);
    const other = holder.clone();
    other.position.x += 8;
    parent.add(other);
    const expected = geometryCenter(holder).add(geometryCenter(other)).multiplyScalar(.5);
    near(selectionCenter([entry, { object: other }]).toArray(), expected.toArray());
});

test('world translation maps through the parent and cancellation restores exact local transforms', () => {
    const { holder, entry } = fixture();
    const original = { position: holder.position.clone(), quaternion: holder.quaternion.clone(), scale: holder.scale.clone() };
    const transaction = new TransformTransaction([entry]);
    const center = transaction.center.clone();
    const movement = new Vector3(1, -2, 3);
    const changes = transaction.apply(transformDelta(center, { translation: movement }));
    near(geometryCenter(holder).toArray(), center.add(movement).toArray());
    assert.equal(changes[0].exhibitId, 'Exhibit');
    assert.equal(changes[0].instanceIndex, 0);
    transaction.restore();
    assert.deepEqual(holder.position.toArray(), original.position.toArray());
    assert.deepEqual(holder.quaternion.toArray(), original.quaternion.toArray());
    assert.deepEqual(holder.scale.toArray(), original.scale.toArray());
});

test('rotation and uniform scaling preserve a displaced geometry pivot without editing shared buffers', () => {
    const { holder, mesh, entry } = fixture();
    const positions = mesh.geometry.attributes.position.array.slice();
    const transaction = new TransformTransaction([entry]);
    transaction.apply(transformDelta(transaction.center, {
        rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3), scale: new Vector3(2, 2, 2)
    }));
    near(geometryCenter(holder).toArray(), transaction.center.toArray());
    assert.deepEqual(mesh.geometry.attributes.position.array, positions);
});

test('unrepresentable shear rejects the whole preview before any selected object changes', () => {
    const first = fixture(), second = fixture();
    second.parent.scale.set(2, 1, 1);
    second.parent.updateMatrixWorld(true);
    const transaction = new TransformTransaction([first.entry, { ...second.entry, exhibitId: 'Other' }]);
    const before = transaction.entries.map(({ object }) => object.matrix.clone().elements);
    assert.throws(() => transaction.apply(transformDelta(transaction.center, {
        rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4)
    })), /transformShear/);
    transaction.entries.forEach(({ object }, index) => assert.deepEqual(object.matrix.elements, before[index]));
});

test('field previews support signed and zero scale and reject out-of-range values', () => {
    const { holder, entry } = fixture();
    const transaction = new TransformTransaction([entry]);
    transaction.localField('position', 0, 12.5);
    assert.equal(holder.position.x, 12.5);
    transaction.localField('scale', 0, -1);
    assert.equal(holder.scale.x, -1);
    transaction.localField('scale', 1, 0);
    assert.equal(holder.scale.y, 0);
    assert.throws(() => transaction.localField('scale', 0, -1000.01), /invalidTransform/);
    transaction.restore();
    assert.equal(holder.position.x, 2);
});

test('numeric expressions support precedence, units and functions without executing code', () => {
    for (const [expression, expected] of [['2 + 3 * 4', 14], ['2**3**2', 512], ['-2**2', -4],
        ['sqrt(9) + sin(pi/2)', 4], ['25cm + 5mm', .255], ['max(2, 5)', 5], ['2 / 4', .5]]) {
        assert.ok(Math.abs(numericValue(expression) - expected) < 1e-10, expression);
    }
    for (const expression of ['globalThis.alert(1)', '1;2', 'constructor(1)', '1/0', '2 +', 'sqrt(-1)']) {
        assert.ok(Number.isNaN(numericValue(expression)), expression);
    }
});

test('simple numeric input supports negation, reciprocal, components and returning to mouse input', () => {
    const input = new TransformInput();
    const key = (value, extra = {}) => input.key({ key: value, ...extra });
    key('2'); key('/');
    assert.equal(input.values()[0], .5);
    key('-');
    assert.equal(input.values()[0], -.5);
    key('Tab'); key('3');
    assert.deepEqual(input.values(), [-.5, 3, 0]);
    assert.equal(input.separate, true);
    key('Tab', { ctrlKey: true });
    assert.equal(input.index, 0);
    key('Backspace'); key('Backspace'); key('Backspace'); key('Backspace');
    assert.equal(input.used, false);
});

test('advanced numeric mode accepts expressions and can switch back to simple input', () => {
    const input = new TransformInput();
    for (const key of ['=', '2', '*', '3']) input.key({ key });
    assert.equal(input.values()[0], 6);
    input.key({ key: '=', ctrlKey: true });
    assert.equal(input.advanced, false);
    assert.equal(input.key({ key: 'q' }), false);
});

test('shared inspector movement respects different exhibit parents and preserves component spacing', () => {
    const first = fixture(), second = fixture();
    second.parent.position.set(-12, 4, 6); second.parent.rotation.y = -.8; second.parent.scale.setScalar(.5);
    second.parent.updateMatrixWorld(true);
    const parents = [first.parent, second.parent].map(object => object.matrix.toArray());
    const transaction = new TransformTransaction([first.entry, { ...second.entry, exhibitId: 'Other' }]);
    const before = [first.holder, second.holder].map(geometryCenter);
    transaction.apply(selectionFieldDelta(transaction.center, 'position', 0, 2));
    for (const [index, object] of [first.holder, second.holder].entries()) near(geometryCenter(object).toArray(), before[index].clone().add(new Vector3(2, 0, 0)).toArray());
    assert.deepEqual([first.parent, second.parent].map(object => object.matrix.toArray()), parents);
    transaction.restore();
    [first.holder, second.holder].forEach((object, index) => near(geometryCenter(object).toArray(), before[index].toArray()));
});

test('whole-exhibit selection rotates parent groups and retains every local component placement', () => {
    const first = fixture(), second = fixture(); second.parent.position.x += 20;
    const locals = [first.holder, second.holder].map(object => object.position.toArray());
    const transaction = new TransformTransaction([{ exhibitId: 'A', object: first.parent }, { exhibitId: 'B', object: second.parent }]);
    const distance = geometryCenter(first.parent).distanceTo(geometryCenter(second.parent));
    transaction.apply(selectionFieldDelta(transaction.center, 'rotation', 1, 45));
    assert.deepEqual([first.holder, second.holder].map(object => object.position.toArray()), locals);
    assert.ok(Math.abs(geometryCenter(first.parent).distanceTo(geometryCenter(second.parent)) - distance) < 1e-8);
    assert.ok(transaction.changes().every(change => change.instanceIndex === undefined));
    transaction.restore();
});

test('shared uniform scaling resizes differently rotated components around the same center', () => {
    const first = fixture(), second = fixture();
    second.parent.position.x += 20; second.parent.rotation.y = -.9; second.holder.rotation.y = .4;
    const transaction = new TransformTransaction([first.entry, { ...second.entry, exhibitId: 'Other' }]);
    const before = geometryCenter(first.holder).distanceTo(geometryCenter(second.holder));
    transaction.apply(selectionFieldDelta(transaction.center, 'scale', 'all', 2));
    assert.ok(Math.abs(geometryCenter(first.holder).distanceTo(geometryCenter(second.holder)) - before * 2) < 1e-8);
    near(first.holder.scale.toArray(), [2, 2, 2]);
    near(second.holder.scale.toArray(), [2, 2, 2]);
    transaction.restore();
});
