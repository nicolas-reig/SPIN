import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { identity, EditSession, validTransform } from '../../frontend/js/domain.js';
import { normalizeHardwareSelection, commonTransform } from '../../frontend/js/transform-selection.js';
registerHooks({ resolve(specifier, context, next) {
    return specifier === 'three' ? { url: new URL('../../frontend/vendor/three/build/three.webgpu.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const THREE = await import('three');
const { TransformController } = await import('../../frontend/js/transform-controller.js');
const { geometryCenter } = await import('../../frontend/js/transform-math.js');
globalThis.window = new EventTarget();
globalThis.document = new EventTarget();
class Canvas extends EventTarget {
    dataset = {}; style = {}; captured = new Set();
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    focus() {}
    hasPointerCapture(id) { return this.captured.has(id); }
    setPointerCapture(id) { this.captured.add(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
}
function setup({ count = 1, parentScale = [1, 1, 1], cameraMode = 'perspective', space = 'world' } = {}) {
    const scene = new THREE.Scene(); const parent = new THREE.Group(); parent.scale.fromArray(parentScale); scene.add(parent);
    const entries = Array.from({ length: count }, (_, index) => {
        const object = new THREE.Group(); object.position.x = index * 4;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
        mesh.position.set(12, 1, -4); object.add(mesh); parent.add(object);
        return { exhibitId: 'E' + index, instanceIndex: 0, object };
    });
    const camera = cameraMode === 'perspective' ? new THREE.PerspectiveCamera(45, 4 / 3, .01, 1000) : new THREE.OrthographicCamera(-20, 20, 15, -15, .01, 1000);
    camera.position.set(30, 30, 30); camera.lookAt(12, 0, -4); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    const controls = { enabled: true }, commits = [], errors = [];
    const controller = new TransformController({ scene, camera, canvas: new Canvas(), controls, onChange() {}, onPreview() {}, onCommit: changes => commits.push(changes), onError: error => errors.push(error) });
    controller.setSelection(entries); controller.configure('combined', false, space);
    const key = (key, extra = {}) => controller.key({ key, ...extra });
    return { controller, entries, parent, camera, controls, commits, errors, key };
}
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test('modal numeric move, cancellation and confirmation affect all selected objects atomically', () => {
    const f = setup({ count: 2 }); const { controller, key, entries } = f;
    controller.begin('translate'); key('x'); key('2');
    near(entries[0].object.position.x, 2); near(entries[1].object.position.x, 6);
    assert.equal(f.commits.length, 0); assert.equal(f.controls.enabled, false);
    key('Escape');
    assert.equal(entries[0].object.position.x, 0); assert.equal(entries[1].object.position.x, 4);
    assert.equal(f.controls.enabled, true);
    controller.begin('translate'); key('x'); key('2'); key('Enter');
    assert.equal(f.commits.length, 1); assert.equal(f.commits[0].length, 2);
    const session = new EditSession({ floors: [], assets: [], exhibits: entries.map(entry => ({ id: entry.exhibitId, transform: identity(), models: [{ model: 'M', transform: identity() }], notes: [], links: [] })) });
    session.change(state => f.commits[0].forEach(change => { state.exhibits.find(record => record.id === change.exhibitId).models[0].transform = change.transform; }));
    assert.equal(session.undoStack.length, 1); session.undo();
    assert.equal(session.value.exhibits[0].models[0].transform.position[0], 0);
    controller.dispose();
});

test('geometry pivots survive rotation, mirroring and flattening without touching buffers', () => {
    const { controller, entries, key } = setup();
    const center = geometryCenter(entries[0].object); const mesh = entries[0].object.children[0];
    const buffer = mesh.geometry.attributes.position.array.slice();
    controller.begin('rotate'); key('y'); key('9'); key('0'); key('Enter');
    near(geometryCenter(entries[0].object).distanceTo(center), 0);
    controller.begin('scale'); key('x'); key('-'); key('1'); key('Enter');
    assert.ok(validTransform(controller.entries[0] && { position: entries[0].object.position.toArray(), rotation: [0, 0, 0], scale: entries[0].object.scale.toArray() }));
    near(geometryCenter(entries[0].object).distanceTo(center), 0);
    controller.begin('scale'); key('0'); key('Enter');
    assert.deepEqual(entries[0].object.scale.toArray().map(value => Math.abs(value)), [0, 0, 0]);
    controller.configure('combined', false, 'local'); controller.update();
    assert.ok(controller.group.quaternion.toArray().every(Number.isFinite));
    assert.deepEqual(mesh.geometry.attributes.position.array, buffer);
    controller.dispose();
});

test('global/local axis cycling, plane exclusion and component numeric input use original orientation', () => {
    const { controller, entries, key } = setup(); entries[0].object.rotation.y = Math.PI / 2;
    controller.begin('translate'); key('x'); key('x'); key('3');
    near(entries[0].object.position.x, 0); near(entries[0].object.position.z, -3);
    key('x'); assert.equal(controller.active.axis, ''); key('Escape');
    controller.begin('translate'); key('y', { shiftKey: true }); key('2');
    near(entries[0].object.position.y, 0); near(entries[0].object.position.x, 2); near(entries[0].object.position.z, 2);
    key('Escape'); controller.begin('translate'); key('1'); key('Tab'); key('2'); key('Tab'); key('3');
    assert.deepEqual(entries[0].object.position.toArray(), [1, 2, 3]); controller.dispose();
});

test('axis previews follow constrained movement, rotation and scale and hide on release', () => {
    const { controller, entries, key } = setup({ count: 2 });
    const { constraintGuide: guide, constraintAxes: lines, constraintPlane: plane } = controller;
    const center = controller.group.position.clone();
    assert.equal(guide.visible, false);
    for (const mode of ['translate', 'rotate', 'scale']) {
        controller.begin(mode); assert.equal(guide.visible, false);
        key('x'); key('2');
        assert.equal(guide.visible, true); assert.equal(plane.visible, false);
        assert.deepEqual(lines.filter(line => line.visible).map(line => line.name), ['X']);
        near(guide.position.distanceTo(controller.group.position), 0);
        near(guide.quaternion.angleTo(controller.active.orientation), 0);
        if (mode === 'translate') near(guide.position.x, center.x + 2);
        else near(guide.position.distanceTo(center), 0);
        key('x'); assert.equal(guide.visible, true);
        key('x'); assert.equal(guide.visible, false);
        key('Escape');
    }
    controller.begin('translate', {}, { axis: 'Z', modal: false });
    assert.equal(guide.visible, true); assert.equal(lines[2].visible, true);
    key('3'); controller.confirm(); assert.equal(guide.visible, false);
    near(entries[0].object.position.z, 3);
    controller.begin('rotate', {}, { axis: 'E' }); assert.equal(guide.visible, false);
    key('r'); assert.equal(controller.active.axis, 'TRACKBALL'); assert.equal(guide.visible, false);
    controller.dispose();
});

test('excluded-axis plane previews show both allowed axes in the original global or local basis', () => {
    const { controller, entries, parent, key } = setup();
    parent.rotation.x = .3; entries[0].object.rotation.z = Math.PI / 4;
    controller.begin('translate'); key('y', { shiftKey: true });
    const { constraintGuide: guide, constraintAxes: lines, constraintPlane: plane } = controller;
    assert.equal(guide.visible, true); assert.equal(plane.visible, true);
    assert.deepEqual(lines.filter(line => line.visible).map(line => line.name), ['X', 'Z']);
    const normal = () => new THREE.Vector3(0, 0, 1).applyQuaternion(plane.getWorldQuaternion(new THREE.Quaternion()));
    near(normal().dot(new THREE.Vector3(0, 1, 0)), 1);
    key('y', { shiftKey: true }); key('2');
    const expectedNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(controller.active.localOrientation);
    near(normal().dot(expectedNormal), 1);
    const displacement = guide.position.clone().sub(controller.active.transaction.center);
    near(displacement.dot(normal()), 0);
    near(displacement.length(), Math.sqrt(8));
    // A preview rotation must leave the guide aligned with the chosen basis.
    key('Escape'); controller.begin('rotate'); key('z'); key('4'); key('5');
    near(guide.quaternion.angleTo(new THREE.Quaternion()), 0);
    assert.ok(controller.group.quaternion.angleTo(guide.quaternion) > .5);
    controller.dispose();
});

test('constraint previews stay visible across camera types and inherit accessibility axis colors', () => {
    for (const cameraMode of ['perspective', 'orthographic']) {
        const { controller, camera, key } = setup({ cameraMode });
        controller.begin('scale', {}, { axis: 'XZ' });
        const { constraintGuide: guide, constraintAxes: lines, constraintPlane: plane } = controller;
        assert.equal(guide.visible, true); const span = plane.scale.x;
        assert.ok(lines[0].scale.x >= camera.far * 2);
        camera.zoom = 2; camera.updateProjectionMatrix(); controller.update(); near(plane.scale.x, span / 2);
        controller.setColors('#aa0088', '#007788', '#cc9900', '#ffffff');
        assert.deepEqual(lines.map(line => line.material.color.getHexString()), ['aa0088', '007788', 'cc9900']);
        assert.equal(plane.material.color.getHexString(), '007788');
        const objects = guide.children.slice();
        for (let i = 0; i < 20; i++) controller.preview();
        assert.deepEqual(guide.children, objects);
        key('Escape'); assert.equal(guide.visible, false);
        controller.dispose(); assert.equal(guide.parent, null);
    }
});

test('numeric errors stay modal, reject confirmation and recover after correction', () => {
    const { controller, key, errors, commits } = setup(); controller.begin('scale'); key('='); key('1'); key('/'); key('0'); key('Enter');
    assert.equal(commits.length, 0); assert.equal(errors.at(-1), 'transformNumber'); assert.ok(controller.active);
    key('Backspace'); key('2'); key('Enter'); assert.equal(commits.length, 1);
    controller.dispose();
});

test('nonuniform parent shear and singular parents reject without partial selection writes', () => {
    const { controller, entries, key, errors, commits } = setup({ count: 2, parentScale: [2, 1, 1] });
    const initial = entries.map(entry => entry.object.position.toArray());
    controller.begin('rotate'); key('y'); key('4'); key('5'); key('Enter');
    assert.equal(errors.at(-1), 'transformShear'); assert.equal(commits.length, 0);
    assert.deepEqual(entries.map(entry => entry.object.position.toArray()), initial); key('Escape');
    entries[0].object.parent.scale.y = 0;
    controller.begin('translate'); key('x'); key('1'); key('Enter'); assert.equal(errors.at(-1), 'transformCollapsedParent');
    controller.dispose();
});

test('selection change, pointer loss, blur and disposal restore previews', () => {
    const { controller, entries, key, controls } = setup();
    const { constraintGuide: guide } = controller;
    const resources = guide.children.flatMap(child => [child.geometry, child.material]); let disposed = 0;
    resources.forEach(resource => resource.addEventListener('dispose', () => disposed++));
    controller.begin('translate'); key('x'); key('7'); controller.setSelection(entries); near(entries[0].object.position.x, 0); assert.equal(guide.visible, false);
    controller.begin('translate'); key('x'); key('7'); window.dispatchEvent(new Event('blur')); near(entries[0].object.position.x, 0); assert.equal(guide.visible, false);
    controller.begin('translate', {}, { modal: false }); controller.active.pointerId = 5; key('x'); key('7'); controller.canvas.dispatchEvent(new Event('lostpointercapture')); near(entries[0].object.position.x, 0); assert.equal(guide.visible, false);
    controller.begin('translate'); key('x'); key('7'); controller.configure('combined', false, 'local'); assert.equal(guide.visible, false);
    controller.begin('translate'); key('x'); key('7'); controller.dispose(); near(entries[0].object.position.x, 0); assert.equal(controls.enabled, true);
    assert.equal(guide.visible, false); assert.equal(guide.parent, null); assert.equal(disposed, resources.length);
});

test('gizmos retain screen size in perspective and orthographic views', () => {
    for (const cameraMode of ['perspective', 'orthographic']) {
        const { controller, camera } = setup({ cameraMode }); const original = controller.group.scale.x;
        camera.zoom = 2; camera.updateProjectionMatrix(); controller.update(); near(controller.group.scale.x, original / 2);
        assert.ok(controller.group.children.some(child => child.userData.mode === 'translate'));
        assert.ok(controller.group.children.some(child => child.userData.mode === 'rotate'));
        assert.ok(controller.group.children.some(child => child.userData.mode === 'scale'));
        controller.dispose();
    }
});

test('hardware selection normalizes duplicate, stale, malformed and other-floor entries', () => {
    const data = { exhibits: [{ id: 'A', floorId: '4', models: [{}, {}] }, { id: 'B', floorId: '5', models: [{}] }] };
    const result = normalizeHardwareSelection([{ exhibitId: 'A', instanceIndex: 1 }, { exhibitId: 'A', instanceIndex: 1 }, { exhibitId: 'A', instanceIndex: 2 }, { exhibitId: 'B', instanceIndex: 0 }, null], data, '4');
    assert.deepEqual(result, [{ exhibitId: 'A', instanceIndex: 1 }]);
    const left = identity(), right = identity(); right.position[0] = 4;
    assert.deepEqual(commonTransform([{ transform: left }, { transform: right }]), { position: [null, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
});

test('real mesh picking and pointer release commit a handle drag once', () => {
    const { controller, camera, entries, commits, controls } = setup();
    const arrow = controller.group.children.find(child => child.geometry.type === 'ConeGeometry' && child.userData.axis === 'X');
    const position = arrow.getWorldPosition(new THREE.Vector3()).project(camera);
    const event = { clientX: (position.x + 1) * 400, clientY: (1 - position.y) * 300, pointerId: 4, button: 0,
        preventDefault() {}, stopImmediatePropagation() {} };
    controller.pointerDown(event);
    assert.equal(controller.active?.mode, 'translate');
    assert.equal(controller.active?.axis, 'X');
    controller.pointerMove({ ...event, clientX: event.clientX + 40 });
    assert.notEqual(entries[0].object.position.x, 0); assert.equal(commits.length, 0);
    controller.pointerUp(event); assert.equal(commits.length, 1); assert.equal(controls.enabled, true);
    controller.dispose();
});

test('precision is incremental and Ctrl snapping applies to mouse previews', () => {
    const { controller, entries, key } = setup(); controller.begin('translate', { clientX: 400, clientY: 300 }); key('x');
    const event = { clientX: 440, clientY: 300, preventDefault() {}, stopImmediatePropagation() {} };
    controller.pointerMove(event); const first = entries[0].object.position.x;
    controller.pointerMove({ ...event, clientX: 480, shiftKey: true }); const precise = entries[0].object.position.x;
    near(precise - first, first * .1);
    controller.pointerMove({ ...event, clientX: 480, ctrlKey: true });
    near(entries[0].object.position.x, Math.round(precise));
    controller.dispose();
});
