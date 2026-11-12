// These helpers release resources owned by a model tree. Geometry must not be
// shared with another live tree; application materials are retained explicitly.
export function disposeMaterials(materials, keepMaterials = new Set()) {
    const keptMaterials = new Set(keepMaterials);
    const textures = new Set();
    const keptTextures = new Set();
    const keptImages = new Set();
    for (const material of keptMaterials) {
        for (const value of Object.values(material)) {
            if (!value?.isTexture) continue;
            keptTextures.add(value);
            keptImages.add(value.source?.data ?? value.image);
        }
    }
    for (const material of new Set(materials)) {
        if (keptMaterials.has(material)) continue;
        for (const value of Object.values(material)) {
            if (value?.isTexture) textures.add(value);
        }
        material.dispose();
    }
    const bitmaps = new Set();
    for (const texture of textures) {
        if (keptTextures.has(texture)) continue;
        const image = texture.source?.data ?? texture.image;
        if (!keptImages.has(image) && typeof globalThis.ImageBitmap === 'function' && image instanceof globalThis.ImageBitmap) bitmaps.add(image);
        texture.dispose();
    }
    // GLTFLoader can clone textures while retaining the same ImageBitmap source.
    // Texture.dispose() releases GPU state, but the owned bitmap needs closing.
    for (const bitmap of bitmaps) bitmap.close();
}

export function replaceMaterials(object, material) {
    const originals = new Set();
    const keptMaterials = new Set([material]);
    object.traverse(node => {
        for (const original of Array.isArray(node.material) ? node.material : [node.material]) {
            if (!original) continue;
            if (!node.isMesh) keptMaterials.add(original);
            else if (original !== material) originals.add(original);
        }
        if (node.isMesh) node.material = material;
    });
    // Supplemental Points and Lines retain their imported materials and sources.
    disposeMaterials(originals, keptMaterials);
}

export function dispose(object, keepMaterials = new Set()) {
    const geometries = new Set();
    const materials = new Set();
    const skeletons = new Set();
    const instances = new Set();
    object.traverse(node => {
        if (node.geometry) geometries.add(node.geometry);
        if (node.material) {
            for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
                if (material && !keepMaterials.has(material)) materials.add(material);
            }
        }
        if (node.isSkinnedMesh && node.skeleton) skeletons.add(node.skeleton);
        if (node.isInstancedMesh) instances.add(node);
    });
    for (const instance of instances) instance.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
    for (const geometry of geometries) geometry.dispose();
    disposeMaterials(materials, keepMaterials);
}
