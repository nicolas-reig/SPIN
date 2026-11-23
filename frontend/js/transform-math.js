import { Box3, Euler, Matrix3, Matrix4, Quaternion, Vector3, MathUtils } from 'three';
import { coordinateNumber, coordinateVector, validTransform, normalizeTransform } from './domain.js';

export const transformKey = ({ exhibitId, instanceIndex }) => JSON.stringify([exhibitId, instanceIndex ?? null]);
export const axisVector = axis => new Vector3(...({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[axis]));

export function applyTransform(object, transform) {
    object.position.fromArray(transform.position);
    object.rotation.set(...transform.rotation.map(MathUtils.degToRad));
    object.scale.fromArray(transform.scale);
}

const groundTolerance = 1e-9;

function minimumPlacementY(object, cache) {
    object.updateWorldMatrix(true, false);
    const matrix = object.matrixWorld.elements;
    const x = matrix[1], y = matrix[5], z = matrix[9], height = matrix[13];
    const previous = cache?.get(object);
    if (previous && previous.x === x && previous.y === y && previous.z === z) {
        const minimum = previous.minimum + (height - previous.height);
        if (previous.precise || minimum >= -groundTolerance) return minimum;
    }
    const box = new Box3().setFromObject(object);
    if (box.isEmpty()) return height;
    const precise = box.min.y < -groundTolerance;
    if (precise) box.setFromObject(object, true);
    cache?.set(object, { x, y, z, height, minimum: box.min.y, precise });
    return box.min.y;
}

export const belowGround = object => minimumPlacementY(object) < -groundTolerance;

function liftPosition(object, position, lift) {
    const parent = object.parent?.matrixWorld || new Matrix4();
    const worldY = [1, 5, 9].map(index => parent.elements[index]);
    const strongest = worldY.reduce((axis, value, index) => Math.abs(value) > Math.abs(worldY[axis]) ? index : axis, 0);
    const heightPerUnit = worldY[strongest];
    if (!heightPerUnit) throw Error('transformCollapsedParent');
    // A collapsed parent can still move a component along a surviving local axis.
    const up = parent.determinant() === 0 ? new Vector3().setComponent(strongest, 1 / heightPerUnit) :
        new Vector3(0, 1, 0).applyMatrix3(new Matrix3().setFromMatrix4(parent.clone().invert()));
    const next = coordinateVector(new Vector3(...position).addScaledVector(up, lift).toArray());
    const gained = worldY.reduce((height, value, axis) => height + value * (next[axis] - position[axis]), 0);
    // A saved position has six decimals. Round toward the ground's safe side if needed.
    if (gained < lift - groundTolerance) {
        const units = Math.ceil((lift - gained) * 1e6 / Math.abs(heightPerUnit));
        next[strongest] = coordinateNumber(next[strongest] + Math.sign(heightPerUnit) * units / 1e6);
    }
    return next;
}

export function applyGroundedTransforms(entries, transforms, cache) {
    const next = transforms.map(normalizeTransform);
    if (next.some(transform => !validTransform(transform))) throw Error('invalidTransform');
    const previous = entries.map(({ object }) => [object.position.clone(), object.rotation.clone(), object.scale.clone()]);
    try {
        entries.forEach(({ object }, index) => applyTransform(object, next[index]));
        const lift = -Math.min(...entries.map(({ object }) => minimumPlacementY(object, cache)));
        if (lift > groundTolerance) entries.forEach(({ object }, index) => {
            const transform = next[index];
            transform.position = liftPosition(object, transform.position, lift);
            if (!validTransform(transform)) throw Error('invalidTransform');
            object.position.fromArray(transform.position);
        });
    } catch (error) {
        entries.forEach(({ object }, index) => {
            const [position, rotation, scale] = previous[index];
            object.position.copy(position);
            object.rotation.copy(rotation);
            object.scale.copy(scale);
            object.updateMatrixWorld(true);
        });
        throw error;
    }
    return entries.map(({ exhibitId, instanceIndex, object }, index) => {
        object.updateMatrixWorld(true);
        return { exhibitId, instanceIndex, transform: next[index] };
    });
}

export function geometryCenter(object) {
    object.updateWorldMatrix(true, true);
    if (object.userData.exhibitPlacement) return componentMedian(object).applyMatrix4(object.matrixWorld);
    if (object.userData.placementCenter) return new Vector3(...object.userData.placementCenter).applyMatrix4(object.matrixWorld);
    const box = new Box3().setFromObject(object, true);
    return box.isEmpty() ? object.getWorldPosition(new Vector3()) : box.getCenter(new Vector3());
}

// Component centers have equal weight, as in Blender's median-point pivot.
// Work in exhibit coordinates so zero/mirrored scales need no matrix inverse.
export function componentMedian(group) {
    const center = new Vector3();
    for (const holder of group.children) {
        holder.updateMatrix();
        center.add(new Vector3(...(holder.userData.placementCenter || [0, 0, 0])).applyMatrix4(holder.matrix));
    }
    return group.children.length ? center.divideScalar(group.children.length) : center;
}

export function exhibitPlacement(group) {
    group.updateMatrix();
    return normalizeTransform({
        position: componentMedian(group).applyMatrix4(group.matrix).toArray(),
        rotation: [group.rotation.x, group.rotation.y, group.rotation.z].map(MathUtils.radToDeg),
        scale: group.scale.toArray()
    });
}

export function selectionCenter(entries) {
    const center = new Vector3();
    for (const { object } of entries) center.add(geometryCenter(object));
    return entries.length ? center.divideScalar(entries.length) : center;
}

export function decomposeTransform(matrix, reference = new Quaternion(), retainOrientation = false) {
    const position = new Vector3().setFromMatrixPosition(matrix);
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const columns = [0, 1, 2].map(index => new Vector3().setFromMatrixColumn(matrix, index));
    const zero = columns.map(column => column.length() === 0);
    if (!zero.some(Boolean)) {
        matrix.decompose(position, quaternion, scale);
        if (retainOrientation) {
            // Signed scales admit four equivalent rotations. Keep the one
            // matching the requested turn instead of flipping the local axes.
            const original = quaternion.clone(), signs = scale.clone();
            let closest = Math.abs(quaternion.dot(reference));
            for (const axis of ['X', 'Y', 'Z']) {
                const candidate = original.clone().multiply(new Quaternion().setFromAxisAngle(axisVector(axis), Math.PI));
                const alignment = Math.abs(candidate.dot(reference));
                if (alignment <= closest) continue;
                closest = alignment; quaternion.copy(candidate);
                scale.copy(signs).multiply(axisVector(axis).multiplyScalar(2).subScalar(1));
            }
        }
    }
    else {
        // A collapsed axis has no recoverable orientation. Complete its basis
        // using the object's retained rotation, as Blender's transform fields do.
        const basis = new Matrix4().makeRotationFromQuaternion(reference);
        const vectors = columns.map((column, index) => {
            const direction = new Vector3().setFromMatrixColumn(basis, index);
            if (zero[index]) return direction;
            return column.clone().normalize().multiplyScalar(retainOrientation && column.dot(direction) < 0 ? -1 : 1);
        });
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
    constructor(entries, { grounded = false } = {}) {
        this.groundCache = grounded ? new WeakMap() : null;
        this.entries = entries.map(entry => {
            const { object } = entry;
            object.updateWorldMatrix(true, true);
            const parent = object.parent?.matrixWorld.clone() || new Matrix4();
            return { ...entry, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
                world: object.matrixWorld.clone(), parent, inverse: parent.clone().invert() };
        });
        this.center = selectionCenter(entries);
    }

    apply(delta, rotation = null) {
        const next = this.entries.map(entry => {
            if (entry.parent.determinant() === 0) throw Error('transformCollapsedParent');
            let reference = entry.quaternion;
            if (rotation) {
                // Track the requested rotation independently of scale, including
                // invisible axes when an object is flattened to zero.
                const basis = entry.inverse.clone().multiply(new Matrix4().makeRotationFromQuaternion(rotation))
                    .multiply(entry.parent).multiply(new Matrix4().makeRotationFromQuaternion(entry.quaternion));
                reference = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(basis)).normalize();
            }
            return decomposeTransform(entry.inverse.clone().multiply(delta).multiply(entry.world), reference, Boolean(rotation));
        });
        if (this.groundCache) return applyGroundedTransforms(this.entries, next.map(value => value.transform), this.groundCache);
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
        if (this.groundCache) return applyGroundedTransforms(this.entries, next, this.groundCache);
        next.forEach((transform, index) => {
            const object = this.entries[index].object;
            applyTransform(object, transform);
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

export class ExhibitPlacementTransaction extends TransformTransaction {
    constructor(exhibitId, group, options) {
        super([{ exhibitId, object: group }], options);
        this.pivot = componentMedian(group);
        this.placement = exhibitPlacement(group);
        this.anchor = new Vector3(...this.placement.position);
    }

    field(key, axis, value) {
        if (!['position', 'rotation', 'scale'].includes(key) || !Number.isInteger(axis) || axis < 0 || axis > 2 || !Number.isFinite(value)) throw Error('invalidTransform');
        const next = structuredClone(this.placement);
        next.position = this.anchor.toArray();
        next[key][axis] = value;
        const quaternion = new Quaternion().setFromEuler(new Euler(...next.rotation.map(MathUtils.degToRad), 'XYZ'));
        const offset = this.pivot.clone().multiply(new Vector3(...next.scale)).applyQuaternion(quaternion);
        const transform = normalizeTransform({ ...next, position: new Vector3(...next.position).sub(offset).toArray() });
        if (!validTransform(transform)) throw Error('invalidTransform');
        if (this.groundCache) return applyGroundedTransforms(this.entries, [transform], this.groundCache);
        const group = this.entries[0].object;
        applyTransform(group, transform);
        group.updateMatrixWorld(true);
        return this.changes();
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
