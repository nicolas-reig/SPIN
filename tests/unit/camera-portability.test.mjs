import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const threeRoot = new URL('../../frontend/vendor/three/', import.meta.url);
registerHooks({
    resolve(specifier, context, nextResolve) {
        let path;
        if (specifier === 'three' || specifier === 'three/webgpu') path = 'build/three.webgpu.js';
        else if (specifier === 'three/tsl') path = 'build/three.tsl.js';
        else if (specifier.startsWith('three/addons/')) path = 'examples/jsm/' + specifier.slice('three/addons/'.length);
        return path ? { url: new URL(path, threeRoot).href, shortCircuit: true } : nextResolve(specifier, context);
    }
});

globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } } };
globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; } };
globalThis.cancelAnimationFrame = () => {};
globalThis.matchMedia = () => ({ matches: true });

const THREE = await import('three');
const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
const { MapView } = await import('../../frontend/js/map.js');
const { boundsCorners, frameBounds, controlLimits, clippingPlanes, clearViewport } = await import('../../frontend/js/camera-framing.js');
const { focusGeometry } = await import('../../frontend/js/camera-focus.js');

function makeView(size = [20, 2, 12], center = [0, 0, 0], aspect = 2) {
    const container = { clientWidth: 800 * aspect, clientHeight: 800 };
    const view = new MapView(container);
    view.requestRender = () => {};
    view.renderer = {
        setSize() {}, dispose() {},
        domElement: { dataset: {}, getBoundingClientRect: () => ({ width: container.clientWidth, height: container.clientHeight }), remove() {} }
    };
    view.transform = { camera: view.camera, dispose() {} };
    view.controls = new OrbitControls(view.camera, null);
    view.controls.domElement = { style: {}, removeEventListener() {}, getRootNode: () => ({ removeEventListener() {} }) };
    view.controls.maxPolarAngle = Math.PI / 2;
    view.controls.minPolarAngle = .000001;
    view.controls.addEventListener('change', () => view.updateCameraClipping());
    const object = new THREE.Mesh(new THREE.BoxGeometry(...size), view.materials.ok);
    object.position.fromArray(center);
    view.root.add(object);
    view.objects.set('box', object);
    view.boundsDirty = true;
    view.updateCameraLimits();
    view.resize();
    return view;
}

function near(actual, expected, tolerance = Math.max(1, Math.abs(expected)) * 1e-10, message = '') {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected} (tolerance ${tolerance})`);
}

function vectorNear(actual, expected, tolerance, message) {
    actual.forEach((value, axis) => near(value, expected[axis], tolerance, `${message} axis ${axis}`));
}

function framed(view, box = view.sceneBounds(), label = '') {
    view.camera.updateMatrixWorld();
    assert.ok(Number.isFinite(view.camera.near) && view.camera.near > 0, `${label}: positive finite near`);
    assert.ok(Number.isFinite(view.camera.far) && view.camera.far > view.camera.near, `${label}: finite far > near`);
    const bounds = view.viewportBounds();
    for (const point of boundsCorners(box)) {
        point.project(view.camera);
        assert.ok(point.x >= bounds.left - 1e-6 && point.x <= bounds.right + 1e-6, `${label}: x ${point.x}`);
        assert.ok(point.y >= bounds.bottom - 1e-6 && point.y <= bounds.top + 1e-6, `${label}: y ${point.y}`);
        assert.ok(point.z >= -1 - 1e-6 && point.z <= 1 + 1e-6, `${label}: depth ${point.z}`);
    }
}

test('ordinary fit retains its existing center, distance and span when all corners already fit', () => {
    const view = makeView();
    view.fit();
    vectorNear(view.controls.target.toArray(), [0, 0, 0], 1e-12, 'center');
    near(view.camera.position.distanceTo(view.controls.target), 32);
    near(view.orthoSpan, 13);
    near(view.controls.minDistance, 2);
    near(view.controls.maxDistance, 450);
    near(view.camera.near, .05);
    near(view.camera.far, 2000);
    framed(view);
    view.destroy();
});

test('fit and fallback frame tall, large, miniature, translated and narrow scenes in both modes', () => {
    const examples = [
        { size: [20, 1200, 10], center: [1000000, 25000, -2000000], aspect: .12 },
        { size: [50000, 12000, 80000], center: [-3000000, 57000, 1700000], aspect: 4 },
        { size: [1e-6, 4e-6, 2e-6], center: [.004, .02, -.003], aspect: .25 },
        { size: [8, 50, 2], center: [-30, 400, 17], aspect: .5 }
    ];
    for (const example of examples) for (const mode of ['perspective', 'top']) {
        const view = makeView(example.size, example.center, example.aspect);
        view.setView(mode);
        view.fit();
        framed(view, view.sceneBounds(), JSON.stringify({ example, mode, action: 'fit' }));
        view.applyView(view.fallbackView(['box']));
        framed(view, view.sceneBounds(), JSON.stringify({ example, mode, action: 'fallback' }));
        assert.ok(view.controls.minDistance <= view.camera.position.distanceTo(view.controls.target));
        assert.ok(view.controls.maxDistance >= view.camera.position.distanceTo(view.controls.target));
        if (example.size[0] < 1) assert.ok(view.camera.far / view.camera.near <= 1e6, 'miniature depth precision');
        view.destroy();
    }
});

test('saved camera distances and spans survive controls updates, zoom and mode changes at every scale', () => {
    for (const scale of [1e-6, 1, 1000]) for (const mode of ['perspective', 'top']) {
        const target = [18 * scale, 35 * scale, -25 * scale];
        const view = makeView([scale, 2 * scale, 3 * scale], target, .3);
        const direction = new THREE.Vector3(.65, .75, 1).normalize();
        const distance = 100 * scale;
        const preset = { target, position: new THREE.Vector3(...target).addScaledVector(direction, distance).toArray(), span: 20 * scale };
        assert.ok([...preset.position, ...preset.target, preset.span].every(value => Math.abs(value) <= 100000), 'saved preset respects the source numeric contract');
        view.applyView(preset, mode);
        vectorNear(view.camera.position.toArray(), preset.position, scale * 1e-8, 'saved position');
        vectorNear(view.controls.target.toArray(), preset.target, scale * 1e-8, 'saved target');
        near(view.orthoSpan, preset.span, scale * 1e-8, 'saved span');
        view.controls.update();
        near(view.camera.position.distanceTo(view.controls.target), distance, scale * 1e-8, 'after OrbitControls.update');
        framed(view, view.sceneBounds(), `${scale}/${mode}`);
        if (mode === 'perspective') {
            view.command('zoomOut');
            near(view.camera.position.distanceTo(view.controls.target), distance * 1.25, scale * 1e-8, 'zoom out');
            view.command('zoomIn');
            near(view.camera.position.distanceTo(view.controls.target), distance, scale * 1e-8, 'zoom in');
        }
        view.setView(mode === 'top' ? 'perspective' : 'top');
        view.setView(mode);
        assert.ok(view.controls.maxDistance >= view.camera.position.distanceTo(view.controls.target));
        assert.ok(view.camera.far > view.camera.near && view.camera.near > 0);
        if (mode === 'perspective') {
            const captured = view.captureView('top');
            const offset = new THREE.Vector3(...captured.position).sub(new THREE.Vector3(...captured.target));
            near(offset.length(), view.camera.position.distanceTo(view.controls.target), scale * 1e-8, 'captured top distance');
            assert.ok(Math.hypot(offset.x, offset.z) <= offset.y * 1.01e-6, 'captured top remains vertical at miniature scales');
        }
        view.destroy();
    }
});

test('accepted below-target, near-pole and exact-pole saved views retain coordinates and angular freedom', () => {
    const directions = [[.2, -.7, 1], [1e-9, 1, 1e-9], [0, 1, 0], [1e-9, -1, 1e-9], [0, -1, 0]];
    for (const scale of [1e-6, 1000]) for (const mode of ['perspective', 'top']) for (const input of directions) {
        const target = [13 * scale, 27 * scale, -19 * scale];
        const view = makeView([scale, scale, scale], target, 1);
        const direction = new THREE.Vector3(...input).normalize();
        const distance = 70 * scale;
        const preset = { target, position: new THREE.Vector3(...target).addScaledVector(direction, distance).toArray(), span: 10 * scale };
        assert.ok([...preset.position, ...preset.target, preset.span].every(value => Math.abs(value) <= 100000), 'imported preset respects the source numeric contract');
        view.applyView(preset, mode);
        vectorNear(view.camera.position.toArray(), preset.position, scale * 1e-9, `${mode} requested coordinates`);
        view.controls.update();
        near(view.camera.position.distanceTo(view.controls.target), distance, scale * 1e-8, `${mode} accepted distance`);
        // Three's spherical.makeSafe imposes its documented 1e-6-radian pole tilt.
        assert.ok(view.camera.position.distanceTo(new THREE.Vector3(...preset.position)) <= distance * 1.01e-6);
        const previousY = view.camera.position.y;
        view.setHeading(45);
        near(view.camera.position.y, previousY, scale * 1e-8, 'heading preserves height below/above target');
        view.destroy();
    }
});

test('legal distant exact-pole presets aim at a miniature target with a narrow orthographic span', () => {
    for (const height of [-100000, 100000]) {
        const view = makeView([1e-7, 1e-7, 1e-7], [0, 0, 0], 1);
        const preset = { position: [0, height, 0], target: [0, 0, 0], span: 1e-6 };
        view.applyView(preset, 'top');
        vectorNear(view.camera.position.toArray(), preset.position, 1e-12, 'exact pole coordinates');
        vectorNear(view.camera.up.toArray(), [0, 1, 0], 1e-12, 'standard controls up axis');
        framed(view, view.sceneBounds(), `exact pole ${height}`);
        assert.equal(view.focusView('box', preset), preset, 'visible pure-pole preset remains unchanged');
        view.destroy();
    }
});

test('focus keeps a visible distant preset and fits hidden or behind-camera geometry in both screen axes', () => {
    for (const mode of ['perspective', 'top']) {
        const view = makeView([30, 400, 20], [0, 9000, 0], .17);
        view.setView(mode);
        const visible = view.fallbackView(['box']);
        assert.equal(view.focusView('box', visible), visible, 'visible preset object is preserved');
        const hidden = { target: [1000, -1000, 1000], position: [1001, -1002, 1001], span: 1 };
        view.applyView(view.focusView('box', hidden));
        framed(view, view.sceneBounds(), mode);
        for (const direction of [[0, 1, 0], [0, -1, 0]]) {
            const pole = { target: [100, 300, 100], position: direction.map((value, i) => [100, 300, 100][i] + value), span: .1 };
            view.applyView(view.focusView('box', pole));
            framed(view, view.sceneBounds(), `${mode} hidden pole`);
        }
        view.destroy();
    }
});

test('a close miniature saved view remains visible inside a much larger building', () => {
    for (const mode of ['perspective', 'top']) {
        const view = makeView([1e-4, 1e-4, 1e-4], [30000, 21000, -17000], .5);
        const building = new THREE.Mesh(new THREE.BoxGeometry(50000, 30000, 50000), view.materials.floor);
        building.position.set(30000, 21000, -17000);
        view.root.add(building);
        view.boundsDirty = true;
        const target = view.objects.get('box').position.toArray();
        const preset = {
            target, position: new THREE.Vector3(...target).addScaledVector(new THREE.Vector3(.65, .75, 1).normalize(), .001).toArray(), span: .001
        };
        view.applyView(preset, mode);
        assert.ok(view.camera.near < .0001, 'near plane follows the close target even when the root bounds straddle the camera');
        const box = new THREE.Box3().setFromObject(view.objects.get('box'));
        framed(view, box, `${mode} mixed scale`);
        assert.equal(view.focusView('box', preset), preset, 'close saved preset is preserved');
        view.destroy();
    }
});

test('Focus uses the selected components or exhibits together and preserves authored single-exhibit views', () => {
    for (const mode of ['perspective', 'top']) {
        const view = makeView([8, 4, .5], [0, 0, 0], 1.2);
        const first = view.objects.get('box'); view.root.remove(first);
        const parent = new THREE.Group(); parent.add(first); view.root.add(parent); view.objects.set('box', parent);
        const unselected = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), view.materials.ok); unselected.position.x = 180; parent.add(unselected);
        const second = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), view.materials.ok); second.position.set(18, 2, -5); view.root.add(second); view.objects.set('second', second);
        const preset = { target: [80, 0, 0], position: [80, 150, 300], span: 120 };
        view.data = { exhibits: [{ id: 'box', views: { '2D': preset, '3D': preset } }, { id: 'second', views: {} }] };
        view.editing = true; view.selection = new Set(['box', 'second']);
        view.hardwareSelection = [{ exhibitId: 'box', instanceIndex: 0 }];
        view.boundsDirty = true; view.setView(mode);
        let cancelled = 0; view.transform.cancel = () => { cancelled++; return false; };
        view.focus();
        assert.equal(cancelled, 1, 'Focus cancels an active preview before measuring geometry');
        assert.deepEqual(view.focusObjects(), [first]);
        assert.ok(view.controls.target.distanceTo(first.position) < 1, 'component focus ignores its parent preset and unselected hardware');
        assert.ok(view.camera.position.distanceTo(view.controls.target) < 25);
        view.hardwareSelection.push({ exhibitId: 'second', instanceIndex: 0 });
        // Use a proper component holder for the second exhibit too.
        const otherParent = new THREE.Group(); view.root.remove(second); otherParent.add(second); view.root.add(otherParent); view.objects.set('second', otherParent);
        view.focus();
        assert.deepEqual(view.focusObjects(), [first, second]);
        assert.ok(view.controls.target.x > 5 && view.controls.target.x < 15, 'shared target lies between the selected components');
        const geometry = focusGeometry([first, second]);
        for (const point of geometry.points) {
            const ndc = point.clone().project(view.camera);
            assert.ok(Math.abs(ndc.x) < .8 && Math.abs(ndc.y) < .8, 'every selected component fits with padding');
        }
        const before = view.camera.position.clone(); view.focus();
        assert.ok(view.camera.position.distanceTo(before) < 1e-5, 'repeated Focus is stable');
        view.hardwareSelection = []; view.focus();
        assert.deepEqual(view.focusObjects(), [parent, otherParent]);
        assert.ok(view.controls.target.x > 50, 'whole-exhibit selection includes its distant hardware');
        view.editing = false; view.selected = 'box'; view.focus();
        vectorNear(view.camera.position.toArray(), preset.position, 1e-8, 'authored preset takes priority');
        view.destroy();
    }
});

test('automatic focus orbits around its pivot without diving through the selection and honors reduced motion', () => {
    const view = makeView([2, 2, 2]);
    const previous = { frame: globalThis.requestAnimationFrame, media: globalThis.matchMedia, performance: globalThis.performance };
    const callbacks = []; let now = 0;
    try {
        globalThis.performance = { now: () => now };
        globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
        globalThis.matchMedia = () => ({ matches: false });
        view.controls.target.set(0, 0, 0); view.camera.position.set(0, 5, 10); view.controls.update();
        const distance = view.camera.position.length(), end = new THREE.Vector3(0, 5, -10);
        view.frameTarget(new THREE.Vector3(), distance, 5, true, end, { orbit: true });
        for (now = 40; now <= 320; now += 40) {
            callbacks.shift()();
            near(view.camera.position.distanceTo(view.controls.target), distance, 1e-7, 'orbit radius remains clear of the pivot');
            near(view.camera.position.y, 5, 1e-7, 'orbit stays above the selection');
            assert.ok(view.orthoSpan > 0);
        }
        vectorNear(view.camera.position.toArray(), end.toArray(), 1e-8, 'final focus pose');
        assert.equal(callbacks.length, 0);
        globalThis.matchMedia = () => ({ matches: true });
        const target = new THREE.Vector3(20, 3, -4), position = new THREE.Vector3(25, 10, 8);
        view.frameTarget(target, target.distanceTo(position), 3, true, position, { orbit: true });
        vectorNear(view.camera.position.toArray(), position.toArray(), 1e-8, 'reduced motion jumps directly to the result');
        assert.equal(callbacks.length, 0);
    } finally {
        globalThis.requestAnimationFrame = previous.frame; globalThis.matchMedia = previous.media; globalThis.performance = previous.performance;
        view.destroy();
    }
});

test('Focus fits the clear map rectangle between floating panels and controls in desktop and mobile layouts', () => {
    const rectangle = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
    for (const layout of [
        { canvas: rectangle(0, 0, 1600, 900), overlays: [rectangle(0, 0, 295, 900), rectangle(1234, 0, 366, 900), rectangle(313, 345, 46, 207), rectangle(309, 773, 911, 101)] },
        { canvas: rectangle(0, 0, 390, 844), overlays: [rectangle(8, 275, 46, 230), rectangle(70, 650, 245, 100), rectangle(0, 779, 390, 65)] }
    ]) for (const mode of ['perspective', 'top']) {
        const view = makeView([10, 7, 3], [10, 1, -5], layout.canvas.width / layout.canvas.height);
        view.viewportBounds = () => clearViewport(layout.canvas, layout.overlays);
        view.selected = 'box'; view.data = { exhibits: [{ id: 'box', views: {} }] };
        view.setView(mode); view.focus();
        const bounds = view.viewportBounds();
        assert.ok(bounds.right > bounds.left && bounds.top > bounds.bottom);
        for (const point of focusGeometry(view.focusObjects()).points) {
            const ndc = point.clone().project(view.camera);
            assert.ok(ndc.x >= bounds.left && ndc.x <= bounds.right && ndc.y >= bounds.bottom && ndc.y <= bounds.top, 'selected geometry stays clear of the panels');
        }
        const projectedTarget = view.controls.target.clone().project(view.camera);
        near(projectedTarget.x, (bounds.left + bounds.right) / 2, 1e-7, 'horizontal center of clear area');
        near(projectedTarget.y, (bounds.top + bounds.bottom) / 2, 1e-7, 'vertical center of clear area');
        framed(view, new THREE.Box3().setFromObject(view.objects.get('box')), mode);
        view.destroy();
    }
});

test('focus framing uses the settled panel layout while its entry spring is still moving', () => {
    const view = makeView([10, 4, 3], [0, 0, 0], 1600 / 900);
    view.container.clientWidth = 1600; view.container.clientHeight = 900;
    const previousStyle = globalThis.getComputedStyle;
    const inspector = { hidden: false, offsetLeft: 1234, offsetTop: 0, offsetWidth: 366, offsetHeight: 900, offsetParent: null,
        getAttribute: () => 'false', getBoundingClientRect() { throw Error('animated panel coordinates must not affect framing'); } };
    const sidebar = { ...inspector, offsetLeft: 0, offsetWidth: 295 };
    const workspace = { querySelectorAll: () => [sidebar, inspector] };
    view.container.closest = () => ({ closest: () => workspace });
    try {
        globalThis.getComputedStyle = () => ({ visibility: 'visible' });
        const bounds = view.viewportBounds();
        near(bounds.left, 307 / 1600 * 2 - 1);
        near(bounds.right, 1222 / 1600 * 2 - 1);
        view.selected = 'box'; view.data = { exhibits: [{ id: 'box' }] };
        view.focus(); framed(view);
        inspector.getAttribute = () => 'true';
        assert.ok(view.viewportBounds().right > bounds.right, 'closing panels no longer reserve map space');
    } finally { globalThis.getComputedStyle = previousStyle; view.destroy(); }
});

test('empty and zero-volume bounds remain finite, and transformed bounds refresh before camera projection', () => {
    const view = makeView();
    const empty = new THREE.Box3();
    const point = new THREE.Box3(new THREE.Vector3(25, 300, -45), new THREE.Vector3(25, 300, -45));
    for (const box of [empty, point]) for (const direction of [new THREE.Vector3(), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)]) {
        const frame = frameBounds(box, direction, .1);
        assert.ok([...frame.position, ...frame.target, frame.span].every(Number.isFinite));
        assert.ok(frame.span > 0);
        assert.ok(Object.values(controlLimits(box, 10)).every(Number.isFinite));
        assert.ok(Object.values(clippingPlanes(box, view.camera)).every(Number.isFinite));
    }
    view.fit();
    const previous = view.sceneBounds().clone();
    view.root.position.set(10000, 8000, -20000);
    view.root.rotation.set(.2, .8, -.1);
    view.objects.get('box').scale.set(400, 2000, 800);
    view.boundsDirty = true; // The TransformControls change listener invalidates this cache.
    view.resize();
    assert.notDeepEqual(view.sceneBounds(), previous);
    view.fit();
    framed(view);
    view.destroy();
});

test('a bounds reader cannot consume invalidation before the render refreshes active camera limits', async () => {
    const view = makeView();
    const oldMaximum = view.controls.maxDistance;
    const callbacks = [];
    const previousAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    try {
        view.requestRender = MapView.prototype.requestRender.bind(view);
        view.renderer.renderAsync = async () => {};
        view.root.scale.setScalar(10000);
        view.boundsDirty = true;
        view.requestRender();
        view.captureView();
        const camera = new THREE.PerspectiveCamera(38, 2, .05, 2000);
        camera.position.set(20, 20, 20);
        camera.lookAt(0, 0, 0);
        view.isVisible('box', camera);
        assert.equal(callbacks.length, 1, 'the pending render remains coalesced');
        await callbacks.shift()();
        assert.ok(view.controls.maxDistance > oldMaximum * 100, 'active controls refresh even after another reader cached the new bounds');
        assert.ok(view.controls.maxDistance >= view.sceneBounds().getSize(new THREE.Vector3()).length() * 8);
    } finally {
        globalThis.requestAnimationFrame = previousAnimationFrame;
        view.destroy();
    }
});

test('deterministic randomized corner checks cover extreme scales, aspect ratios and translations', t => {
    let state = 0x4c21a7;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    let checked = 0;
    for (let index = 0; index < 100; index++) {
        const scale = 10 ** (-7 + random() * 14);
        const size = Array.from({ length: 3 }, () => scale * 10 ** (-1 + random() * 2));
        const center = Array.from({ length: 3 }, () => (random() - .5) * scale * 10000);
        const aspect = 10 ** (-1.2 + random() * 2.4);
        for (const mode of ['perspective', 'top']) {
            const view = makeView(size, center, aspect);
            view.setView(mode);
            view.fit();
            framed(view, view.sceneBounds(), `case ${index} ${mode} fit`);
            const preset = view.fallbackView(['box']);
            view.applyView(preset);
            framed(view, view.sceneBounds(), `case ${index} ${mode} fallback`);
            view.controls.update();
            framed(view, view.sceneBounds(), `case ${index} ${mode} controls`);
            checked += 3 * 8;
            view.destroy();
        }
    }
    t.diagnostic(`${checked} real Three camera corner projections checked across 100 deterministic synthetic bounds and both modes`);
});
