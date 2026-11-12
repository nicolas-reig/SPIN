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

// Only the color-preference module's initial DOM writes need a host; no renderer runs.
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } } };
globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; } };
globalThis.cancelAnimationFrame = () => {};

const THREE = await import('three');
const { MapView } = await import('../../frontend/js/map.js');

function disposals(resource) {
    let count = 0;
    resource.addEventListener('dispose', () => { count++; });
    return () => count;
}

const transform = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => ({ position, rotation, scale });

function dataset(count = 4, model = 'hardware') {
    const half = Math.ceil(count / 2);
    return {
        floors: [{ id: 'floor', modelId: null, transform: transform([3, 0, -2], [0, 15, 0]), views: {} }],
        assets: [{ id: model, url: '/' + model + '.glb' }],
        exhibits: ['first', 'second'].map((id, group) => ({
            id, floorId: 'floor', status: group ? 'problem' : 'ok',
            transform: transform([group * 7, group, -group], [0, group * 30, 0], [1 + group, 1, 1]),
            models: Array.from({ length: group ? count - half : half }, (_, index) => ({
                model, transform: transform([index * 2, 0, index], [0, index * 10, 0], [1, 1 + index / 10, 1])
            }))
        }))
    };
}

function sourceScene({ skinned = false, morph = false, instanced = false } = {}) {
    const scene = new THREE.Group();
    scene.position.set(1, 2, 3);
    scene.rotation.y = .3;
    scene.scale.set(-1, 2, .5);
    const geometry = new THREE.BoxGeometry(1, 2, 3);
    let smoothing = 0;
    const toNonIndexed = geometry.toNonIndexed;
    geometry.toNonIndexed = function () { smoothing++; return toNonIndexed.call(this); };
    if (morph) {
        const target = geometry.attributes.position.clone();
        target.setY(0, target.getY(0) + 1);
        geometry.morphAttributes.position = [target];
    }
    const material = new THREE.MeshStandardMaterial();
    const mesh = skinned ? new THREE.SkinnedMesh(geometry, material) :
        instanced ? new THREE.InstancedMesh(geometry, material, 2) : new THREE.Mesh(geometry, material);
    mesh.position.set(.4, .2, -.7);
    mesh.rotation.x = .2;
    if (skinned) {
        const bone = new THREE.Bone();
        scene.add(bone);
        mesh.bind(new THREE.Skeleton([bone]));
    }
    if (morph && !instanced) mesh.morphTargetInfluences[0] = .4;
    scene.add(mesh);
    return { scene, mesh, geometry, smoothing: () => smoothing, geometryDisposals: disposals(geometry), materialDisposals: disposals(material) };
}

function makeView(options = {}) {
    const records = [];
    const calls = [];
    const states = [];
    const view = new MapView({}, { onState: state => states.push(state) });
    view.requestRender = () => {};
    view.loader = {
        async loadAsync(url) {
            calls.push(url);
            const record = sourceScene(options);
            records.push(record);
            return { scene: record.scene };
        }
    };
    return { view, records, calls, states };
}

function meshes(object) {
    const result = [];
    object.traverse(child => { if (child.isMesh) result.push(child); });
    return result;
}

function geometryMemory(object) {
    const buffers = new Set();
    const geometries = new Set();
    for (const mesh of meshes(object)) {
        const geometry = mesh.geometry;
        geometries.add(geometry);
        for (const attribute of [...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat(), geometry.index]) {
            if (attribute) buffers.add((attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array).buffer);
        }
    }
    return { geometries: geometries.size, buffers: buffers.size, bytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) };
}

test('actual setData loads and smooths a repeated unskinned asset once, with separate object transforms and materials', async () => {
    const { view, calls, records } = makeView();
    const data = dataset();
    const sharedDisposals = Object.values(view.materials).map(disposals);

    await view.setData(data, 'floor', null);

    assert.deepEqual(calls, ['/hardware.glb']);
    assert.equal(records[0].smoothing(), 1);
    assert.equal(records[0].geometryDisposals(), 1);
    assert.equal(records[0].materialDisposals(), 1);
    const all = meshes(view.root);
    assert.equal(all.length, 4);
    assert.equal(new Set(all.map(mesh => mesh.geometry)).size, 1);
    assert.equal(new Set(all).size, 4);
    assert.equal(all[0].material, view.materials.ok);
    assert.equal(all[2].material, view.materials.problem);
    assert.ok(sharedDisposals.every(count => count() === 0));
    const first = view.objects.get('first');
    const second = view.objects.get('second');
    assert.deepEqual(first.position.toArray(), data.exhibits[0].transform.position);
    assert.deepEqual(second.scale.toArray(), data.exhibits[1].transform.scale);
    assert.deepEqual(first.children[1].position.toArray(), data.exhibits[0].models[1].transform.position);
    assert.deepEqual(first.children[0].children[0].position.toArray(), [1, 2, 3]);
    assert.deepEqual(second.children[0].children[0].scale.toArray(), [-1, 2, .5]);
    view.root.updateMatrixWorld(true);
    assert.notDeepEqual(all[0].matrixWorld.elements, all[1].matrixWorld.elements);
    assert.notDeepEqual(all[0].matrixWorld.elements, all[2].matrixWorld.elements);
    first.children[0].position.x += 100;
    assert.equal(first.children[1].position.x, 2);
    assert.equal(second.children[0].position.x, 0);
    view.destroy();
});

test('64 repeated models retain one set of geometry buffers instead of 64', async t => {
    const data = dataset(64);
    const cached = makeView();
    const uncached = makeView();
    // Exercise the same model-loading path without a per-build template map as a reference.
    const model = uncached.view.model;
    uncached.view.model = function (asset, material, templates, generation) {
        return model.call(this, asset, material, null, generation);
    };
    await uncached.view.setData(data, 'floor', null);
    await cached.view.setData(data, 'floor', null);

    const before = geometryMemory(uncached.view.root);
    const after = geometryMemory(cached.view.root);
    assert.equal(uncached.calls.length, 64);
    assert.equal(cached.calls.length, 1);
    assert.equal(uncached.records.reduce((sum, record) => sum + record.smoothing(), 0), 64);
    assert.equal(cached.records[0].smoothing(), 1);
    assert.equal(before.geometries, 64);
    assert.equal(after.geometries, 1);
    assert.equal(before.buffers, after.buffers * 64);
    assert.equal(before.bytes, after.bytes * 64);
    t.diagnostic(JSON.stringify({ instances: 64, uncached: before, shared: after, geometryBufferReductionPercent: 100 * (1 - after.bytes / before.bytes) }));
    uncached.view.destroy();
    cached.view.destroy();
});

test('status-only changes reuse the installed scene and rebuilding uses independently disposable geometry', async () => {
    const { view, calls } = makeView();
    const data = dataset();
    await view.setData(data, 'floor', null);
    const firstRoot = view.root;
    const previous = meshes(view.root)[0].geometry;
    const previousDisposals = disposals(previous);
    const statusData = structuredClone(data);
    statusData.exhibits[0].status = 'retired';

    await view.setData(statusData, 'floor', null);

    assert.equal(view.root, firstRoot);
    assert.equal(calls.length, 1);
    assert.equal(meshes(view.objects.get('first'))[0].material, view.materials.retired);
    assert.equal(previousDisposals(), 0);
    statusData.exhibits[0].models[0].transform.position[0] += 2;
    await view.setData(statusData, 'floor', 'first');
    const current = meshes(view.root)[0].geometry;
    const currentDisposals = disposals(current);
    assert.equal(calls.length, 2);
    assert.notEqual(current, previous);
    assert.notEqual(current.attributes.position.array.buffer, previous.attributes.position.array.buffer);
    assert.equal(previousDisposals(), 1);
    assert.equal(currentDisposals(), 0);
    assert.equal(meshes(view.objects.get('first'))[0].material, view.materials.selection);
    view.destroy();
    assert.equal(previousDisposals(), 1);
    assert.equal(currentDisposals(), 1);
});

test('skinned assets retain fresh scene and skeleton loading for every instance', async () => {
    const { view, calls, records } = makeView({ skinned: true });
    await view.setData(dataset(), 'floor', null);

    const all = meshes(view.root);
    assert.equal(calls.length, 4);
    assert.equal(new Set(all.map(mesh => mesh.skeleton)).size, 4);
    assert.equal(new Set(all.map(mesh => mesh.skeleton.bones[0])).size, 4);
    assert.equal(new Set(all.map(mesh => mesh.geometry)).size, 4);
    assert.ok(records.every(record => record.smoothing() === 1));
    all[1].skeleton.bones[0].position.x = 9;
    assert.equal(all[0].skeleton.bones[0].position.x, 0);
    view.destroy();
});

test('shared geometry keeps per-mesh morph weights and instanced transforms independent', async () => {
    const morph = makeView({ morph: true });
    await morph.view.setData(dataset(2), 'floor', null);
    const [first, second] = meshes(morph.view.root);
    assert.equal(first.geometry, second.geometry);
    assert.notEqual(first.morphTargetInfluences, second.morphTargetInfluences);
    second.morphTargetInfluences[0] = .9;
    assert.equal(first.morphTargetInfluences[0], .4);
    morph.view.destroy();

    const instanced = makeView({ instanced: true });
    await instanced.view.setData(dataset(2), 'floor', null);
    const [a, b] = meshes(instanced.view.root);
    assert.equal(a.geometry, b.geometry);
    assert.notEqual(a.instanceMatrix, b.instanceMatrix);
    assert.notEqual(a.instanceMatrix.array.buffer, b.instanceMatrix.array.buffer);
    b.setMatrixAt(0, new THREE.Matrix4().makeTranslation(50, 0, 0));
    assert.equal(a.instanceMatrix.array[12], 0);
    assert.equal(b.instanceMatrix.array[12], 50);
    instanced.view.destroy();
});

test('missing floor and absent model assets remain supported without loading', async () => {
    const { view, calls, states } = makeView();
    const data = dataset();
    data.assets = [];
    await view.setData(data, 'floor', null);
    assert.equal(view.objects.size, 2);
    assert.equal(meshes(view.root).length, 0);
    assert.equal(calls.length, 0);
    await view.setData(data, 'missing-floor', null);
    assert.equal(view.objects.size, 0);
    assert.equal(view.floor, null);
    assert.equal(states.at(-1), 'mapReady');
    view.destroy();
});

test('obsolete raw loads are disposed before smoothing and stop further instance loads', async () => {
    const { view, calls } = makeView();
    const raw = sourceScene();
    let resolve;
    view.loader.loadAsync = url => { calls.push(url); return new Promise(done => { resolve = done; }); };
    const data = dataset();
    data.floors[0].modelId = 'hardware';
    const loading = view.setData(data, 'floor', null);
    assert.equal(calls.length, 1);
    await view.setData({ floors: [], assets: [], exhibits: [] }, null, null);
    resolve({ scene: raw.scene });
    await loading;

    assert.equal(calls.length, 1);
    assert.equal(raw.smoothing(), 0);
    assert.equal(raw.geometryDisposals(), 1);
    assert.equal(raw.materialDisposals(), 1);
    assert.equal(view.objects.size, 0);
    view.destroy();
});

test('cancellation between model completion and caller continuation releases the attached template once', async () => {
    const { view, calls } = makeView();
    const raw = sourceScene();
    let prepared;
    raw.geometry.addEventListener('dispose', () => {
        prepared = raw.mesh.geometry;
        queueMicrotask(() => view.setData({ floors: [], assets: [], exhibits: [] }, null, null));
    });
    let preparedDisposals = 0;
    view.loader.loadAsync = async url => {
        calls.push(url);
        return { scene: raw.scene };
    };
    // Smoothing swaps geometry after firing the original's dispose event.
    const originalModel = view.model;
    view.model = async function (...args) {
        const result = await originalModel.apply(this, args);
        if (result?.children.some(child => child.isMesh)) {
            prepared = meshes(result)[0].geometry;
            prepared.addEventListener('dispose', () => { preparedDisposals++; });
        }
        return result;
    };
    await view.setData(dataset(), 'floor', null);

    assert.equal(calls.length, 1);
    assert.equal(raw.smoothing(), 1);
    assert.equal(raw.geometryDisposals(), 1);
    assert.equal(preparedDisposals, 1);
    assert.equal(view.objects.size, 0);
    view.destroy();
});

test('an obsolete build cannot dispose or replace a newer installed build', async () => {
    const { view, states } = makeView();
    const obsolete = sourceScene();
    const current = sourceScene();
    let resolve;
    view.loader.loadAsync = url => url === '/old.glb' ? new Promise(done => { resolve = done; }) : Promise.resolve({ scene: current.scene });
    const oldData = dataset(2, 'old');
    oldData.floors[0].modelId = 'old';
    const pending = view.setData(oldData, 'floor', null);
    const nextData = dataset(2, 'current');
    await view.setData(nextData, 'floor', null);
    const installed = view.root;
    const liveGeometry = meshes(installed)[0].geometry;
    const liveDisposals = disposals(liveGeometry);
    resolve({ scene: obsolete.scene });
    await pending;

    assert.equal(obsolete.smoothing(), 0);
    assert.equal(obsolete.geometryDisposals(), 1);
    assert.equal(view.root, installed);
    assert.equal(liveDisposals(), 0);
    assert.equal(states.at(-1), 'mapReady');
    view.destroy();
    assert.equal(liveDisposals(), 1);
});

test('destroy invalidates a pending load and its late result is released without installing', async () => {
    const { view, states } = makeView();
    const raw = sourceScene();
    let resolve;
    view.loader.loadAsync = () => new Promise(done => { resolve = done; });
    const data = dataset();
    data.floors[0].modelId = 'hardware';
    const pending = view.setData(data, 'floor', null);
    view.destroy();
    resolve({ scene: raw.scene });
    await pending;

    assert.equal(raw.smoothing(), 0);
    assert.equal(raw.geometryDisposals(), 1);
    assert.equal(view.objects.size, 0);
    assert.deepEqual(states, ['mapLoading']);
});

test('preprocessing errors release the unattached imported scene and report mapUnavailable', async () => {
    const { view, calls, states } = makeView();
    const raw = sourceScene();
    raw.geometry.toNonIndexed = () => { throw new Error('synthetic geometry preprocessing failure'); };
    view.loader.loadAsync = async url => {
        calls.push(url);
        return { scene: raw.scene };
    };

    await view.setData(dataset(), 'floor', null);

    assert.deepEqual(calls, ['/hardware.glb']);
    assert.equal(raw.geometryDisposals(), 1);
    assert.equal(raw.materialDisposals(), 1);
    assert.equal(raw.scene.parent, null);
    assert.equal(view.root.children.length, 0);
    assert.equal(view.objects.size, 0);
    assert.equal(view.floor, null);
    assert.deepEqual(states, ['mapLoading', 'mapUnavailable']);
    view.destroy();
    assert.equal(raw.geometryDisposals(), 1);
    assert.equal(raw.materialDisposals(), 1);
});
