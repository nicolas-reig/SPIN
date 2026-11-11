import { Matrix4, Vector3, Quaternion, Euler, MathUtils } from 'three';
import { validTransform } from './domain.js';

const matrix = transform => new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation.map(MathUtils.degToRad))),
    new Vector3(...transform.scale)
);

export function joinExhibits(records, targetId) {
    const target = records.find(record => record.id === targetId);
    if (!target || records.length < 2) throw Error('invalidInput');
    const floors = new Set(records.filter(record => record.models.length && record.floorId).map(record => record.floorId));
    if (floors.size > 1) throw Error('joinDifferentFloors');
    if (records.reduce((count, record) => count + record.models.length, 0) > 100) throw Error('joinTooManyModels');
    const joined = structuredClone(target);
    const inverse = matrix(target.transform).invert();
    for (const record of records) {
        if (record.id === targetId) continue;
        const parent = inverse.clone().multiply(matrix(record.transform));
        for (const instance of record.models) {
            const world = parent.clone().multiply(matrix(instance.transform));
            const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
            world.decompose(position, rotation, scale);
            const restored = new Matrix4().compose(position, rotation, scale);
            if (world.elements.some((value, index) => Math.abs(value - restored.elements[index]) > .00001 * Math.max(1, Math.abs(value)))) {
                throw Error('joinUnevenScale');
            }
            const angles = new Euler().setFromQuaternion(rotation);
            const transform = {
                position: position.toArray(),
                rotation: [angles.x, angles.y, angles.z].map(MathUtils.radToDeg),
                scale: scale.toArray()
            };
            if (!validTransform(transform)) throw Error('invalidTransform');
            joined.models.push({ model: instance.model, transform });
        }
    }
    joined.floorId = [...floors][0] || target.floorId;
    if (joined.models.length && !joined.floorId) throw Error('chooseFloorFirst');
    joined.joinedFrom = [...new Set([
        ...(target.joinedFrom || []),
        ...records.filter(record => record.id !== targetId).flatMap(record => [record.id, ...(record.joinedFrom || [])])
    ])].filter(id => id !== targetId);
    joined.notes = records.flatMap(record => record.notes);
    joined.links = records.flatMap(record => record.links);
    joined.placed = Boolean(joined.floorId && joined.models.length);
    return joined;
}
