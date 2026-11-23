import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const three = new URL('../../frontend/vendor/three/build/three.webgpu.js', import.meta.url);
registerHooks({
    resolve(specifier, context, nextResolve) {
        return specifier === 'three' ? { url: three.href, shortCircuit: true } : nextResolve(specifier, context);
    }
});

const { Group, OrthographicCamera, PerspectiveCamera, Vector3 } = await import('three');
const { MapOverlays } = await import('../../frontend/js/map-overlays.js');

class Element {
    children = [];
    dataset = {};
    style = { setProperty() {} };
    classList = { toggle() {} };
    attributes = new Map();
    append(node) { this.children.push(node); node.parentNode = this; }
    remove() { this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(type, listener) { this[type] = listener; }
}

globalThis.document = { createElement: () => new Element() };

test('map overlays use transformed exhibit pivots and center each prefix group on the current floor', () => {
    const floor = new Group();
    floor.position.set(4, 0, -3);
    floor.rotation.y = Math.PI / 2;
    const exhibits = [
        { id: 'first', name: 'Gallery - first', status: 'ok' },
        { id: 'second', name: 'gallery - second', status: 'problem' },
        { id: 'third', name: 'No prefix', status: 'ok' },
        { id: 'upstairs', name: 'Gallery - upstairs', status: 'ok' }
    ];
    const objects = new Map();
    for (const [id, x, centers] of [['first', 0, [0, 8]], ['second', 10, [4]], ['third', 4, [0]]]) {
        const exhibit = new Group();
        exhibit.position.x = x;
        floor.add(exhibit);
        for (const center of centers) {
            const component = new Group();
            component.userData.placementCenter = [center, 0, 0];
            exhibit.add(component);
        }
        objects.set(id, exhibit);
    }

    const selections = [], container = new Element();
    const overlay = new MapOverlays(container, (...args) => selections.push(args));
    const camera = new OrthographicCamera(-24, 24, 18, -18, .1, 150);
    camera.position.set(0, 40, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    const frame = { camera, width: 800, height: 600, exhibits, objects, selection: new Set(['first']), circles: true, labels: true };
    overlay.render(frame);

    const layer = container.children[0];
    const labels = layer.children.filter(element => element.dataset.mapGroup !== undefined);
    assert.deepEqual(labels.map(label => label.textContent), ['Gallery']);
    const circle = layer.children.find(element => element.dataset.mapCircle === 'first');
    assert.equal(circle.getAttribute('aria-label'), 'Gallery - first');
    assert.equal(circle.getAttribute('aria-pressed'), 'true');
    const position = element => element.style.translate.split(' ').map(Number.parseFloat);
    const project = (x, activeCamera = frame.camera) => {
        const point = new Vector3(x, 0, 0).applyMatrix4(floor.matrixWorld).project(activeCamera);
        return [(point.x + 1) * frame.width / 2, (1 - point.y) * frame.height / 2];
    };
    assert.deepEqual(position(circle), project(4));
    assert.deepEqual(position(labels[0]), project(9), 'Each exhibit contributes one center regardless of component count');
    const [x, y] = position(circle);
    assert.equal(overlay.pick(x, y), 'first');
    assert.equal(overlay.pick(x + 23, y), null);
    circle.click({ shiftKey: true });
    assert.deepEqual(selections, [['first', true]]);

    objects.get('second').position.x += 6;
    overlay.invalidate();
    overlay.render(frame);
    assert.deepEqual(position(labels[0]), project(12));
    assert.ok(layer.children.includes(circle), 'Refreshing placement keeps the existing keyboard control');

    const perspective = new PerspectiveCamera(50, 4 / 3, .1, 150);
    perspective.position.set(14, 20, -38);
    perspective.lookAt(0, 0, 0);
    overlay.render({ ...frame, camera: perspective, circles: false });
    assert.equal(layer.children.some(element => element.dataset.mapCircle !== undefined), false);
    assert.deepEqual(position(labels[0]), project(12, perspective));
    assert.equal(overlay.pick(x, y), null);

    overlay.destroy();
    assert.equal(container.children.length, 0);
});
