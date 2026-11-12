import test from 'node:test';
import assert from 'node:assert/strict';
import {
    Bone, BoxGeometry, BufferGeometry, DataTexture, Float32BufferAttribute,
    Group, InstancedMesh, Line, LineBasicMaterial, Mesh, MeshStandardMaterial,
    Points, PointsMaterial, Skeleton, SkinnedMesh, Texture
} from '../../frontend/vendor/three/build/three.core.js';
import { dispose, disposeMaterials, replaceMaterials } from '../../frontend/js/model-resources.js';

function disposals(resource) {
    let count = 0;
    resource.addEventListener('dispose', () => { count++; });
    return () => count;
}

function withBitmapClass(t) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
    // A source-only lifetime sentinel; no image data is created or decoded.
    class ImageBitmap {
        closes = 0;
        close() { this.closes++; }
    }
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, writable: true, value: ImageBitmap });
    t.after(() => {
        if (original) Object.defineProperty(globalThis, 'ImageBitmap', original);
        else delete globalThis.ImageBitmap;
    });
    return ImageBitmap;
}

test('repeated model instances share buffers and release them once while status materials stay live', () => {
    const geometry = new BoxGeometry();
    const status = new MeshStandardMaterial({ color: 0x008800 });
    const selected = new MeshStandardMaterial({ color: 0x0088ff });
    const geometryDisposals = disposals(geometry);
    const statusDisposals = disposals(status);
    const selectedDisposals = disposals(selected);
    const root = new Group();
    const template = new Mesh(geometry, status);
    root.add(template);
    for (let i = 1; i < 64; i++) {
        const instance = template.clone(true);
        instance.position.x = i * 2;
        if (i === 1) instance.material = selected;
        root.add(instance);
    }
    const buffers = new Set(root.children.map(mesh => mesh.geometry.attributes.position.array.buffer));
    assert.equal(buffers.size, 1);
    assert.equal(root.children[1].position.x, 2);
    assert.equal(template.position.x, 0);
    assert.equal(root.children[1].material, selected);
    assert.equal(template.material, status);

    dispose(root, new Set([status, selected]));

    assert.equal(geometryDisposals(), 1);
    assert.equal(statusDisposals(), 0);
    assert.equal(selectedDisposals(), 0);
    disposeMaterials([status, selected]);
});

test('disposing an obsolete build preserves separate geometry in the current build', () => {
    const previous = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const current = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const oldDisposals = disposals(previous.geometry);
    const liveDisposals = disposals(current.geometry);
    assert.notEqual(previous.geometry.attributes.position.array.buffer, current.geometry.attributes.position.array.buffer);

    dispose(previous);

    assert.equal(oldDisposals(), 1);
    assert.equal(liveDisposals(), 0);
    assert.equal(current.geometry.attributes.position.count, 24);
    dispose(current);
});

test('replacing imported materials closes one bitmap shared by distinct textures', t => {
    const ImageBitmap = withBitmapClass(t);
    const bitmap = new ImageBitmap();
    const original = new Texture(bitmap);
    const clone = original.clone();
    assert.equal(clone.source, original.source);
    const first = new MeshStandardMaterial({ map: original });
    const second = new MeshStandardMaterial({ map: clone, normalMap: original });
    const firstDisposals = disposals(first);
    const secondDisposals = disposals(second);
    const originalDisposals = disposals(original);
    const cloneDisposals = disposals(clone);
    const geometry = new BoxGeometry();
    const geometryDisposals = disposals(geometry);
    const status = new MeshStandardMaterial();
    const statusDisposals = disposals(status);
    const root = new Group();
    root.add(new Mesh(geometry, [first, second, first]), new Mesh(geometry, second));

    replaceMaterials(root, status);

    assert.ok(root.children.every(mesh => mesh.material === status));
    assert.equal(firstDisposals(), 1);
    assert.equal(secondDisposals(), 1);
    assert.equal(originalDisposals(), 1);
    assert.equal(cloneDisposals(), 1);
    assert.equal(bitmap.closes, 1);
    assert.equal(statusDisposals(), 0);
    assert.equal(geometryDisposals(), 0);
    dispose(root, new Set([status]));
    assert.equal(bitmap.closes, 1);
    assert.equal(statusDisposals(), 0);
    disposeMaterials([status]);
});

test('ordinary image sources and retained application textures are not closed', t => {
    withBitmapClass(t);
    const ordinaryImage = { closes: 0, close() { this.closes++; } };
    const texture = new Texture(ordinaryImage);
    const retained = new MeshStandardMaterial({ map: texture });
    const textureDisposals = disposals(texture);
    const materialDisposals = disposals(retained);
    const root = new Mesh(new BoxGeometry(), retained);

    dispose(root, new Set([retained]));

    assert.equal(textureDisposals(), 0);
    assert.equal(materialDisposals(), 0);
    assert.equal(ordinaryImage.closes, 0);
    disposeMaterials([retained]);
    assert.equal(textureDisposals(), 1);
    assert.equal(ordinaryImage.closes, 0);
});

test('material cleanup works when ImageBitmap is unavailable and deduplicates material inputs', t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
    delete globalThis.ImageBitmap;
    t.after(() => { if (original) Object.defineProperty(globalThis, 'ImageBitmap', original); });
    const texture = new DataTexture(new Uint8Array(4), 1, 1);
    const material = new MeshStandardMaterial({ map: texture, normalMap: texture });
    const materialDisposals = disposals(material);
    const textureDisposals = disposals(texture);

    disposeMaterials([material, material]);

    assert.equal(materialDisposals(), 1);
    assert.equal(textureDisposals(), 1);
});

test('retained material textures and their bitmap aliases survive model disposal', t => {
    const ImageBitmap = withBitmapClass(t);
    const bitmap = new ImageBitmap();
    const shared = new Texture(bitmap);
    const discardedClone = shared.clone();
    const retained = new MeshStandardMaterial({ map: shared });
    const discarded = new MeshStandardMaterial({ map: shared, normalMap: discardedClone });
    const sharedDisposals = disposals(shared);
    const cloneDisposals = disposals(discardedClone);
    const materialDisposals = disposals(discarded);
    const root = new Group();
    const geometry = new BoxGeometry();
    root.add(new Mesh(geometry, retained), new Mesh(geometry, discarded));

    dispose(root, new Set([retained]));

    assert.equal(materialDisposals(), 1);
    assert.equal(sharedDisposals(), 0);
    assert.equal(cloneDisposals(), 1);
    assert.equal(bitmap.closes, 0);
    disposeMaterials([retained]);
    assert.equal(sharedDisposals(), 1);
    assert.equal(bitmap.closes, 1);
});

test('replacement material retains a bitmap source shared with an imported texture', t => {
    const ImageBitmap = withBitmapClass(t);
    const bitmap = new ImageBitmap();
    const importedTexture = new Texture(bitmap);
    const replacementTexture = importedTexture.clone();
    const imported = new MeshStandardMaterial({ map: importedTexture });
    const replacement = new MeshStandardMaterial({ map: replacementTexture });
    const textureDisposals = disposals(importedTexture);
    const replacementDisposals = disposals(replacementTexture);
    const root = new Mesh(new BoxGeometry(), imported);

    replaceMaterials(root, replacement);

    assert.equal(textureDisposals(), 1);
    assert.equal(replacementDisposals(), 0);
    assert.equal(bitmap.closes, 0);
    dispose(root);
    assert.equal(replacementDisposals(), 1);
    assert.equal(bitmap.closes, 1);
});

test('mesh replacement preserves Points and Line materials with shared texture and bitmap aliases', t => {
    const ImageBitmap = withBitmapClass(t);
    const bitmap = new ImageBitmap();
    const retainedTexture = new Texture(bitmap);
    const lineTexture = retainedTexture.clone();
    const discardedTexture = retainedTexture.clone();
    const imported = [
        new MeshStandardMaterial({ map: retainedTexture }),
        new MeshStandardMaterial({ map: discardedTexture })
    ];
    const pointsMaterial = new PointsMaterial({ map: retainedTexture });
    const lineMaterial = new LineBasicMaterial({ map: lineTexture });
    const replacement = new MeshStandardMaterial();
    const importedDisposals = imported.map(disposals);
    const pointsDisposals = disposals(pointsMaterial);
    const lineDisposals = disposals(lineMaterial);
    const retainedTextureDisposals = disposals(retainedTexture);
    const lineTextureDisposals = disposals(lineTexture);
    const discardedTextureDisposals = disposals(discardedTexture);
    const geometry = new BoxGeometry();
    const root = new Group();
    const mesh = new Mesh(geometry, imported);
    const points = new Points(geometry, pointsMaterial);
    const line = new Line(geometry, lineMaterial);
    root.add(mesh, points, line);

    replaceMaterials(root, replacement);

    assert.equal(mesh.material, replacement);
    assert.equal(points.material, pointsMaterial);
    assert.equal(line.material, lineMaterial);
    assert.ok(importedDisposals.every(count => count() === 1));
    assert.equal(pointsDisposals(), 0);
    assert.equal(lineDisposals(), 0);
    assert.equal(retainedTextureDisposals(), 0);
    assert.equal(lineTextureDisposals(), 0);
    assert.equal(discardedTextureDisposals(), 1);
    assert.equal(bitmap.closes, 0);

    dispose(root);
    assert.equal(pointsDisposals(), 1);
    assert.equal(lineDisposals(), 1);
    assert.equal(retainedTextureDisposals(), 1);
    assert.equal(lineTextureDisposals(), 1);
    assert.equal(bitmap.closes, 1);
});

test('a material shared with a non-mesh primitive stays live after mesh replacement', () => {
    const imported = new LineBasicMaterial();
    const replacement = new MeshStandardMaterial();
    const importedDisposals = disposals(imported);
    const geometry = new BoxGeometry();
    const root = new Group();
    const mesh = new Mesh(geometry, imported);
    const line = new Line(geometry, imported);
    root.add(mesh, line);

    replaceMaterials(root, replacement);

    assert.equal(mesh.material, replacement);
    assert.equal(line.material, imported);
    assert.equal(importedDisposals(), 0);
    dispose(root);
    assert.equal(importedDisposals(), 1);
});

test('shared skeleton bone textures are released once across skinned mesh parts', () => {
    const bone = new Bone();
    const skeleton = new Skeleton([bone]);
    skeleton.computeBoneTexture();
    const texture = skeleton.boneTexture;
    const boneTextureDisposals = disposals(texture);
    const geometry = new BoxGeometry();
    const geometryDisposals = disposals(geometry);
    const material = new MeshStandardMaterial();
    const first = new SkinnedMesh(geometry, material);
    const second = new SkinnedMesh(geometry, material);
    first.bind(skeleton);
    second.bind(skeleton);
    const root = new Group();
    root.add(first, second, bone);
    assert.ok(texture.image.data.byteLength > 0);

    dispose(root);

    assert.equal(boneTextureDisposals(), 1);
    assert.equal(skeleton.boneTexture, null);
    assert.equal(geometryDisposals(), 1);
});

test('instanced mesh disposal releases per-object morph textures and preserves shared materials', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.morphAttributes.position = [new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 2, 0], 3)];
    const material = new MeshStandardMaterial();
    const model = new Mesh(geometry, material);
    model.morphTargetInfluences[0] = .5;
    const first = new InstancedMesh(geometry, material, 3);
    const second = new InstancedMesh(geometry, material, 2);
    first.setMorphAt(0, model);
    second.setMorphAt(0, model);
    const firstDisposals = disposals(first);
    const secondDisposals = disposals(second);
    const firstTextureDisposals = disposals(first.morphTexture);
    const secondTextureDisposals = disposals(second.morphTexture);
    const materialDisposals = disposals(material);
    const geometryDisposals = disposals(geometry);
    const root = new Group();
    root.add(first, second);
    assert.notEqual(first.morphTexture, second.morphTexture);
    assert.equal(first.instanceMatrix.array.byteLength, 3 * 16 * Float32Array.BYTES_PER_ELEMENT);

    dispose(root, new Set([material]));

    assert.equal(firstDisposals(), 1);
    assert.equal(secondDisposals(), 1);
    assert.equal(firstTextureDisposals(), 1);
    assert.equal(secondTextureDisposals(), 1);
    assert.equal(first.morphTexture, null);
    assert.equal(second.morphTexture, null);
    assert.equal(geometryDisposals(), 1);
    assert.equal(materialDisposals(), 0);
    disposeMaterials([material]);
});
