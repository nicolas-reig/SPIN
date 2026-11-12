import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
    return specifier === 'three' ? { url: new URL('../../frontend/vendor/three/build/three.webgpu.js', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const THREE = await import('three');
const { focusGeometry, nextBestView, birdFocusView } = await import('../../frontend/js/camera-focus.js');
const { aimCamera } = await import('../../frontend/js/camera-framing.js');
const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const box = (size = [6, 4, .2]) => new THREE.Mesh(new THREE.BoxGeometry(...size), material);
function cameraFor(view, aspect = 1, top = false) {
    const camera = top ? new THREE.OrthographicCamera(-view.span * aspect, view.span * aspect, view.span, -view.span, 1e-10, 1e12) : new THREE.PerspectiveCamera(38, aspect, 1e-10, 1e12);
    camera.position.fromArray(view.position); aimCamera(camera, new THREE.Vector3(...view.target)); camera.updateMatrixWorld();
    return camera;
}
function contained(geometry, view, aspect, top) {
    const camera = cameraFor(view, aspect, top);
    for (const point of geometry.points) {
        const projected = point.clone().project(camera);
        assert.ok(Math.abs(projected.x) <= .79 && Math.abs(projected.y) <= .79, `outside focus padding: ${projected.toArray()}`);
        assert.ok(projected.z >= -1 && projected.z <= 1, 'all geometry lies in front of the camera');
    }
}

test('next-best-view search turns an edge-on display toward a readable broad face', () => {
    const mesh = box(), geometry = focusGeometry([mesh]);
    const current = new THREE.Vector3(1, .3, .01).normalize();
    const view = nextBestView(geometry, { direction: current, occluders: [mesh] });
    const direction = new THREE.Vector3(...view.position).sub(new THREE.Vector3(...view.target)).normalize();
    assert.ok(Math.abs(direction.z) > .8, 'broad face is visible instead of its thin edge');
    contained(geometry, view, 1, false);
    const repeat = nextBestView(geometry, { direction, occluders: [mesh] });
    near(new THREE.Vector3(...repeat.position).distanceTo(new THREE.Vector3(...view.position)), 0);
});

test('visibility scoring chooses the open side when a wall hides the otherwise preferred angle', () => {
    const mesh = box(), wall = box([30, 30, .5]); wall.position.z = 4;
    wall.updateMatrixWorld();
    const geometry = focusGeometry([mesh]);
    const view = nextBestView(geometry, { direction: new THREE.Vector3(0, .5, 1).normalize(), occluders: [mesh, wall] });
    assert.ok(view.position[2] < 0, 'focus moves to the unobstructed side');
    const origin = new THREE.Vector3(...view.position), target = new THREE.Vector3(...view.target);
    const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize(), 0, origin.distanceTo(target));
    assert.equal(ray.intersectObject(wall).length, 0);
    contained(geometry, view, 1, false);
});

test('framing respects nested transforms, displaced geometry, multiple objects and narrow viewports at every scale', () => {
    for (const scale of [1e-6, 1, 1000]) for (const aspect of [.18, 2.4]) {
        const parent = new THREE.Group(); parent.position.set(4000 * scale, 100 * scale, -5000 * scale); parent.rotation.set(.1, .4, 0); parent.scale.set(-scale, scale * 2, scale);
        const first = box([20, 3, 2]); first.geometry.translate(12, 1, -4); first.rotation.y = .7;
        const second = box([2, 12, 3]); second.position.set(-15, 4, 7);
        parent.add(first, second);
        const geometry = focusGeometry([first, second]);
        const buffers = first.geometry.attributes.position.array.slice();
        for (const top of [false, true]) {
            const view = (top ? birdFocusView : nextBestView)(geometry, { aspect });
            assert.ok([...view.position, ...view.target, view.span].every(Number.isFinite));
            contained(geometry, view, aspect, top);
        }
        assert.deepEqual(first.geometry.attributes.position.array, buffers, 'focus leaves source geometry intact');
    }
});

test('bird view fits the rotated footprint rather than model height and uses viewport aspect', () => {
    const mesh = box([20, 1000, 2]); mesh.rotation.y = Math.PI / 4;
    const geometry = focusGeometry([mesh]);
    const view = birdFocusView(geometry, { aspect: 2 });
    const northSpan = Math.max(geometry.box.getSize(new THREE.Vector3()).x / (4 * .78), geometry.box.getSize(new THREE.Vector3()).z / (2 * .78));
    assert.ok(view.span < northSpan * .8, 'heading search provides a materially tighter footprint fit');
    assert.ok(view.span < 10, 'height does not force the bird view to zoom far out');
    assert.ok(view.position[1] > geometry.box.max.y, 'camera clears the tallest selected point');
    contained(geometry, view, 2, true);
    const direction = new THREE.Vector3(...view.position).sub(new THREE.Vector3(...view.target));
    const repeated = birdFocusView(geometry, { aspect: 2, direction });
    near(repeated.span, view.span);
    near(new THREE.Vector3(...repeated.position).distanceTo(new THREE.Vector3(...view.position)), 0);
});

test('bird view preserves the current heading when reframing would offer little improvement', () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 8, 64), material);
    const geometry = focusGeometry([mesh]), direction = new THREE.Vector3(.0000006, 1, -.0000008);
    const view = birdFocusView(geometry, { direction });
    const chosen = new THREE.Vector3(...view.position).sub(new THREE.Vector3(...view.target));
    near(Math.atan2(chosen.x, chosen.z), Math.atan2(direction.x, direction.z));
    contained(geometry, view, 1, true);
});

test('empty, flattened and point-like selections stay finite and instanced geometry includes every placement', () => {
    const empty = focusGeometry([]); assert.equal(nextBestView(empty), null); assert.equal(birdFocusView(empty), null);
    const mesh = box(); mesh.scale.set(0, 0, 0);
    for (const focus of [nextBestView, birdFocusView]) {
        const view = focus(focusGeometry([mesh]));
        assert.ok([...view.position, ...view.target, view.span].every(Number.isFinite)); assert.ok(view.span > 0);
    }
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 3, 4), material, 2);
    instanced.setMatrixAt(1, new THREE.Matrix4().makeTranslation(12, 4, -8));
    const geometry = focusGeometry([instanced]);
    assert.ok(geometry.box.min.z <= -10 && geometry.box.max.x >= 13);
    contained(geometry, nextBestView(geometry), 1, false);
    contained(geometry, birdFocusView(geometry), 1, true);
});

test('search bounds expensive visibility work instead of raycasting every candidate and triangle sample', () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(2, 160, 120), material);
    const geometry = focusGeometry([mesh]);
    assert.ok(geometry.points.length <= 8 && geometry.samples.length <= 384);
    let casts = 0;
    const obstacle = new THREE.Object3D(); obstacle.raycast = () => { casts++; };
    nextBestView(geometry, { occluders: [obstacle] });
    assert.ok(casts > 0 && casts <= 8 * 18, `${casts} visibility rays`);
});
