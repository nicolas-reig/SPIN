import { Vector3 } from 'three';

const halfFov = Math.tan(38 * Math.PI / 360);

export function boundsScale(box) {
    const size = box.getSize(new Vector3());
    return Math.max(size.x, size.y, size.z) || 10;
}

export function boundsCorners(box) {
    if (box.isEmpty()) return [];
    const points = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        points.push(new Vector3(x, y, z));
    }
    return points;
}

export function aimCamera(camera, target) {
    const offset = camera.position.clone().sub(target);
    const up = camera.up.clone();
    // Three.lookAt perturbs a parallel up/direction pair by 1e-4 radians.
    // At a distant exact pole that can move a small orthographic target offscreen.
    if (!offset.x && !offset.z && offset.y) camera.up.set(0, 0, offset.y > 0 ? -1 : 1);
    camera.lookAt(target);
    camera.up.copy(up);
}

// Solve the perspective inequalities at every corner rather than assuming the
// horizontal footprint also describes a model's height or its projected width.
export function frameBounds(box, direction, aspect, { distance = 0, span = 0, perspective = true, horizontal = .94, vertical = .94 } = {}) {
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const backward = direction.clone();
    if (!backward.lengthSq()) backward.set(.65, .75, 1);
    // A pure pole has no unique horizontal basis. Use the same tiny tilt as
    // OrbitControls, proportional to distance so miniature models stay upright.
    if (!backward.x && !backward.z) backward.z = Math.abs(backward.y) * 1e-6;
    backward.normalize();
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), backward).normalize();
    const up = new Vector3().crossVectors(backward, right);
    if (!size.lengthSq()) {
        distance = Math.max(distance, 16);
        span = Math.max(span, 6.5);
    }
    const margin = Math.max(size.length() * 1e-5, boundsScale(box) * 1e-12);
    let requiredDistance = 0;
    let requiredSpan = 0;
    // Center-relative coordinates keep translated small models precise.
    for (const x of [-size.x / 2, size.x / 2]) for (const y of [-size.y / 2, size.y / 2]) for (const z of [-size.z / 2, size.z / 2]) {
        const point = new Vector3(x, y, z);
        const depth = point.dot(backward);
        const width = Math.abs(point.dot(right)) / (aspect * horizontal);
        const height = Math.abs(point.dot(up)) / vertical;
        requiredSpan = Math.max(requiredSpan, width, height);
        requiredDistance = Math.max(requiredDistance, depth + (perspective ? Math.max(width, height) / halfFov : 0));
    }
    distance = Math.max(distance, requiredDistance + margin);
    span = Math.max(span, requiredSpan * (1 + 1e-6), margin);
    return { target: center.toArray(), position: center.clone().addScaledVector(backward, distance).toArray(), span };
}

export function controlLimits(box, currentDistance, requestedDistance = currentDistance) {
    const unitScale = Math.min(1, boundsScale(box) / 10);
    const distances = [currentDistance, requestedDistance].filter(value => Number.isFinite(value) && value > 0);
    return {
        minDistance: Math.min(2 * unitScale, ...distances.map(value => value / 2)),
        maxDistance: Math.max(450 * unitScale, box.getSize(new Vector3()).length() * 8, ...distances,
            Number.isFinite(requestedDistance) ? requestedDistance * 2 : 0)
    };
}

export function clippingPlanes(box, camera, targetDistance = Infinity) {
    if (box.isEmpty()) return { near: .05, far: 2000 };
    const unitScale = Math.min(1, boundsScale(box) / 10);
    const points = boundsCorners(box);
    camera.updateMatrixWorld();
    const forward = camera.getWorldDirection(new Vector3());
    const depths = points.map(point => point.sub(camera.position).dot(forward));
    const nearest = Math.min(...depths);
    const furthest = Math.max(...depths);
    const margin = Math.max(box.getSize(new Vector3()).length() * .05, Math.abs(furthest) * 1e-6);
    const far = Math.max(2000 * unitScale, furthest + margin);
    // Keep the familiar planes for ordinary scenes, scale them down for small
    // ones, and improve depth precision when viewing a very distant model.
    const preferredNear = Math.max(.05 * unitScale, far / 1e6);
    const targetNear = Number.isFinite(targetDistance) && targetDistance > 0 ? targetDistance * .01 : Infinity;
    const near = Math.min(preferredNear, nearest > 0 ? nearest / 2 : .05 * unitScale, targetNear);
    return { near, far };
}
