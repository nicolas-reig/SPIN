import { Box3, Euler, Matrix4, Quaternion, Vector3, MathUtils } from 'three';
import { validTransform, normalizeTransform } from './domain.js';

export const transformKey = ({ exhibitId, instanceIndex }) => JSON.stringify([exhibitId, instanceIndex ?? null]);
export const axisVector = axis => new Vector3(...({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[axis]));

export function geometryCenter(object) {
    object.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(object, true);
    return box.isEmpty() ? object.getWorldPosition(new Vector3()) : box.getCenter(new Vector3());
}

export function selectionCenter(entries) {
    const center = new Vector3();
    for (const { object } of entries) center.add(geometryCenter(object));
    return entries.length ? center.divideScalar(entries.length) : center;
}

export function decomposeTransform(matrix, reference = new Quaternion()) {
    const position = new Vector3().setFromMatrixPosition(matrix);
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const columns = [0, 1, 2].map(index => new Vector3().setFromMatrixColumn(matrix, index));
    const zero = columns.map(column => column.length() === 0);
    if (!zero.some(Boolean)) matrix.decompose(position, quaternion, scale);
    else {
        // A collapsed axis has no recoverable orientation. Complete its basis
        // using the object's retained rotation, as Blender's transform fields do.
        const basis = new Matrix4().makeRotationFromQuaternion(reference);
        const vectors = columns.map((column, index) => zero[index]
            ? new Vector3().setFromMatrixColumn(basis, index) : column.clone().normalize());
        const present = zero.flatMap((empty, index) => empty ? [] : [index]);
        if (present.length === 2) {
            const missing = zero.indexOf(true);
            vectors[missing].crossVectors(vectors[(missing + 1) % 3], vectors[(missing + 2) % 3]).normalize();
        } else if (present.length === 1) {
            const index = present[0];
            const rotation = new Quaternion().setFromUnitVectors(new Vector3().setFromMatrixColumn(basis, index), vectors[index]);
            for (let i = 0; i < 3; i++) if (i !== index) vectors[i].applyQuaternion(rotation);
        }
        quaternion.setFromRotationMatrix(new Matrix4().makeBasis(...vectors)).normalize();
        scale.set(...columns.map((column, index) => column.dot(vectors[index])));
    }
    const restored = new Matrix4().compose(position, quaternion, scale);
    const magnitude = Math.max(1e-12, ...columns.map(column => column.length()));
    if (matrix.elements.some((value, index) => index % 4 !== 3 && index < 12 &&
        Math.abs(value - restored.elements[index]) > magnitude * 1e-7)) throw Error('transformShear');
    const rotation = new Euler().setFromQuaternion(quaternion, 'XYZ');
    const transform = { position: position.toArray(), rotation: [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg), scale: scale.toArray() };
    if (!validTransform(transform)) throw Error('invalidTransform');
    return { position, quaternion, scale, transform: normalizeTransform(transform) };
}

export class TransformTransaction {
    constructor(entries) {
        this.entries = entries.map(entry => {
            const { object } = entry;
            object.updateWorldMatrix(true, true);
            const parent = object.parent?.matrixWorld.clone() || new Matrix4();
            return { ...entry, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
                world: object.matrixWorld.clone(), parent, inverse: parent.clone().invert() };
        });
        this.center = selectionCenter(entries);
    }

    apply(delta) {
        const next = this.entries.map(entry => {
            if (entry.parent.determinant() === 0) throw Error('transformCollapsedParent');
            return decomposeTransform(entry.inverse.clone().multiply(delta).multiply(entry.world), entry.quaternion);
        });
        next.forEach((value, index) => {
            const object = this.entries[index].object;
            object.position.copy(value.position);
            object.quaternion.copy(value.quaternion);
            object.scale.copy(value.scale);
            object.updateMatrixWorld(true);
        });
        return this.changes();
    }

    localField(key, axis, value) {
        const next = this.entries.map(entry => {
            const angles = new Euler().setFromQuaternion(entry.quaternion, 'XYZ');
            const transform = { position: entry.position.toArray(), rotation: [angles.x, angles.y, angles.z].map(MathUtils.radToDeg), scale: entry.scale.toArray() };
            transform[key][axis] = value;
            if (!validTransform(transform)) throw Error('invalidTransform');
            return transform;
        });
        next.forEach((transform, index) => {
            const object = this.entries[index].object;
            object.position.fromArray(transform.position);
            object.rotation.set(...transform.rotation.map(MathUtils.degToRad));
            object.scale.fromArray(transform.scale);
            object.updateMatrixWorld(true);
        });
        return this.changes();
    }

    changes() {
        return this.entries.map(({ exhibitId, instanceIndex, object }) => ({ exhibitId, instanceIndex,
            transform: normalizeTransform({ position: object.position.toArray(), rotation: [object.rotation.x, object.rotation.y, object.rotation.z].map(MathUtils.radToDeg), scale: object.scale.toArray() }) }));
    }

    restore() {
        for (const { object, position, quaternion, scale } of this.entries) {
            object.position.copy(position); object.quaternion.copy(quaternion); object.scale.copy(scale); object.updateMatrixWorld(true);
        }
    }
}

export function transformDelta(center, { translation = new Vector3(), rotation = new Quaternion(), scale = new Vector3(1, 1, 1), orientation = new Quaternion() } = {}) {
    const basis = new Matrix4().makeRotationFromQuaternion(orientation);
    return new Matrix4().makeTranslation(...center.clone().add(translation).toArray())
        .multiply(new Matrix4().makeRotationFromQuaternion(rotation)).multiply(basis)
        .multiply(new Matrix4().makeScale(...scale.toArray())).multiply(basis.clone().invert())
        .multiply(new Matrix4().makeTranslation(...center.clone().negate().toArray()));
}

export function selectionFieldDelta(center, key, axis, value, orientation = new Quaternion()) {
    if (key === 'scale' && axis === 'all' && Number.isFinite(value)) return transformDelta(center, { scale: new Vector3().setScalar(value), orientation });
    if (!['position', 'rotation', 'scale'].includes(key) || !Number.isInteger(axis) || axis < 0 || axis > 2 || !Number.isFinite(value)) throw Error('invalidTransform');
    const direction = axisVector(['X', 'Y', 'Z'][axis]).applyQuaternion(orientation);
    return transformDelta(center, {
        translation: key === 'position' ? direction.multiplyScalar(value) : new Vector3(),
        rotation: key === 'rotation' ? new Quaternion().setFromAxisAngle(direction, MathUtils.degToRad(value)) : new Quaternion(),
        scale: key === 'scale' ? new Vector3(1, 1, 1).setComponent(axis, value) : new Vector3(1, 1, 1),
        orientation
    });
}
