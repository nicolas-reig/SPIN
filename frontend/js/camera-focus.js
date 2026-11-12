import { Box3, Matrix4, Raycaster, Vector3 } from 'three';
import { boundsCorners } from './camera-framing.js';
import { orbitOffset } from './camera.js';

const radians = Math.PI / 180;
const up = new Vector3(0, 1, 0);
const halfFov = Math.tan(19 * radians);
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Keep the search independent of mesh tessellation and bounded for large assets.
// Small meshes use every posed vertex; large ones use conservative mesh bounds.
export function focusGeometry(objects) {
    const parts = [], points = [], samples = [];
    for (const [owner, object] of [...new Set(objects)].entries()) {
        object.updateWorldMatrix(true, true);
        object.traverseVisible(mesh => {
            if (!mesh.isMesh || !mesh.geometry.attributes.position) return;
            const count = mesh.isInstancedMesh ? mesh.count : 1;
            for (let instance = 0; instance < count; instance++) {
                const matrix = mesh.matrixWorld.clone();
                if (mesh.isInstancedMesh) {
                    const local = new Matrix4(); mesh.getMatrixAt(instance, local); matrix.multiply(local);
                }
                parts.push({ mesh, matrix, owner });
            }
        });
    }
    const vertexBudget = Math.max(8, Math.floor(8192 / Math.max(1, parts.length)));
    const sampleBudget = Math.max(1, Math.floor(384 / Math.max(1, parts.length)));
    for (const { mesh, matrix, owner } of parts) {
        const geometry = mesh.geometry, positions = geometry.attributes.position;
        const vertex = index => mesh.getVertexPosition(index, new Vector3()).applyMatrix4(matrix);
        if (positions.count <= vertexBudget) {
            for (let i = 0; i < positions.count; i++) points.push(vertex(i));
        } else {
            if (mesh.isSkinnedMesh) mesh.computeBoundingBox();
            else if (!geometry.boundingBox) geometry.computeBoundingBox();
            for (const point of boundsCorners(mesh.isSkinnedMesh ? mesh.boundingBox : geometry.boundingBox)) points.push(point.applyMatrix4(matrix));
        }
        const index = geometry.index;
        const start = geometry.drawRange.start;
        const triangles = Math.floor(Math.min((index?.count ?? positions.count) - start, geometry.drawRange.count) / 3);
        const count = Math.min(sampleBudget, triangles);
        for (let i = 0; i < count; i++) {
            const triangle = start + Math.floor((i + .5) * triangles / count) * 3;
            const vertices = [0, 1, 2].map(offset => vertex(index ? index.getX(triangle + offset) : triangle + offset));
            const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0]));
            const area = normal.length() * .5 * triangles / count;
            if (!area) continue;
            samples.push({ point: vertices[0].add(vertices[1]).add(vertices[2]).multiplyScalar(1 / 3), normal: normal.normalize(), area, owner });
        }
    }
    const finite = points.filter(point => point.toArray().every(Number.isFinite));
    return { points: finite, samples, box: new Box3().setFromPoints(finite) };
}

function basis(direction) {
    const backward = direction.clone().normalize();
    if (!backward.lengthSq()) backward.set(.45, .55, 1).normalize();
    if (Math.hypot(backward.x, backward.z) < 1e-8) backward.z = 1e-6;
    backward.normalize();
    const right = new Vector3().crossVectors(up, backward).normalize();
    return { backward, right, vertical: new Vector3().crossVectors(backward, right) };
}

function fitPoints(geometry, direction, aspect, { horizontal = .78, vertical = .78 } = {}) {
    const { backward, right, vertical: cameraUp } = basis(direction);
    const origin = geometry.box.getCenter(new Vector3());
    const points = geometry.points.map(point => point.clone().sub(origin));
    const xs = points.map(point => point.dot(right)), ys = points.map(point => point.dot(cameraUp));
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2, midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const target = origin.addScaledVector(right, midX).addScaledVector(cameraUp, midY);
    let distance = 0, span = 0;
    const scale = geometry.box.getSize(new Vector3()).length() || 1;
    points.forEach((point, index) => {
        const extent = Math.max(Math.abs(xs[index] - midX) / (aspect * horizontal), Math.abs(ys[index] - midY) / vertical);
        span = Math.max(span, extent);
        distance = Math.max(distance, point.dot(backward) + extent / halfFov);
    });
    distance = Math.max(distance + scale * .015, scale * .1);
    return { target: target.toArray(), position: target.clone().addScaledVector(backward, distance).toArray(), span: Math.max(span, scale * .05) };
}

// Approximate viewpoint information with projected surface area and normal-bin
// entropy, rather than triangle count (which rewards unnecessarily dense meshes).
// Reference: Vázquez et al., Viewpoint Selection using Viewpoint Entropy (2001).
function information(geometry, direction, view, aspect) {
    const bins = new Map(); let area = 0;
    const distance = new Vector3(...view.position).distanceTo(new Vector3(...view.target));
    for (const sample of geometry.samples) {
        const projected = sample.area * Math.abs(sample.normal.dot(direction));
        const normal = sample.normal.toArray();
        const dominant = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
        const bin = dominant * 2 + (normal[dominant] < 0 ? 1 : 0);
        bins.set(bin, (bins.get(bin) || 0) + projected); area += projected;
    }
    let entropy = 0;
    if (area) for (const value of bins.values()) if (value) entropy -= value / area * Math.log(value / area) / Math.log(6);
    return { area, entropy, coverage: Math.min(1, area / (4 * aspect * Math.pow(distance * halfFov, 2))) };
}

function visibility(geometry, candidate, occluders, budget) {
    const weighted = geometry.samples.map(sample => ({ sample, weight: sample.area * Math.abs(sample.normal.dot(candidate.direction)) }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (!total || !occluders.length) return 1;
    const origin = new Vector3(...candidate.view.position), ray = new Raycaster(), hits = [];
    const epsilon = Math.max(geometry.box.getSize(new Vector3()).length() * 1e-5, origin.length() * Number.EPSILON * 32);
    let visible = 0, index = 0, cumulative = weighted[0]?.weight || 0;
    // Stratified area-weighted samples give large and small triangles equal
    // influence per unit surface, without casting hundreds of rays per angle.
    for (let i = 0; i < budget; i++) {
        const weight = (i + .5) * total / budget;
        while (cumulative < weight && index < weighted.length - 1) cumulative += weighted[++index].weight;
        const delta = weighted[index].sample.point.clone().sub(origin);
        ray.set(origin, delta.clone().normalize()); ray.far = Math.max(0, delta.length() - epsilon);
        hits.length = 0; ray.intersectObjects(occluders, true, hits);
        if (!hits.length) visible++;
    }
    return visible / budget;
}

export function nextBestView(geometry, { aspect = 1, direction = new Vector3(.65, .75, 1), padding, occluders = [] } = {}) {
    if (!geometry.points.length) return null;
    const current = basis(direction).backward;
    const directions = [current];
    for (const elevation of [20, 35, 50, 65]) for (let heading = 0; heading < 360; heading += 30) {
        directions.push(new Vector3(...orbitOffset(1, heading, elevation)));
    }
    // Include the actual surface directions so thin/diagonal hardware does not
    // depend on whether its broad face happens to align with the angular grid.
    for (const sample of [...geometry.samples].sort((a, b) => b.area - a.area).slice(0, 12)) {
        for (const sign of [-1, 1]) {
            const normal = sample.normal.clone().multiplyScalar(sign);
            const heading = -Math.atan2(normal.x, normal.z) / radians;
            const elevation = Math.max(20, Math.min(70, Math.atan2(normal.y, Math.hypot(normal.x, normal.z)) / radians));
            directions.push(new Vector3(...orbitOffset(1, heading, elevation)));
        }
    }
    const candidates = directions.map(direction => {
        const view = fitPoints(geometry, direction, aspect, padding);
        return { direction, view, ...information(geometry, direction, view, aspect) };
    });
    const maxArea = Math.max(...candidates.map(candidate => candidate.area)) || 1;
    for (const candidate of candidates) {
        const motion = Math.acos(Math.max(-1, Math.min(1, candidate.direction.dot(current)))) / Math.PI;
        candidate.score = .65 * candidate.area / maxArea + .25 * candidate.coverage + .1 * candidate.entropy - .06 * motion;
    }
    candidates.sort((a, b) => b.score - a.score);
    const finalists = [];
    for (const candidate of candidates) {
        if (finalists.every(other => other.direction.dot(candidate.direction) < Math.cos(25 * radians))) finalists.push(candidate);
        if (finalists.length === 8) break;
    }
    let best = finalists[0], score = -Infinity;
    for (const candidate of finalists) {
        const value = candidate.score * (.2 + .8 * visibility(geometry, candidate, occluders, 18));
        if (value > score) { best = candidate; score = value; }
    }
    return best.view;
}

function footprintHull(points) {
    const sorted = points.map(point => ({ x: point.x, y: point.z })).sort((a, b) => a.x - b.x || a.y - b.y);
    const unique = sorted.filter((point, index) => !index || point.x !== sorted[index - 1].x || point.y !== sorted[index - 1].y);
    if (unique.length < 3) return unique;
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const half = list => {
        const hull = [];
        for (const point of list) {
            while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
            hull.push(point);
        }
        return hull.slice(0, -1);
    };
    return [...half(unique), ...half(unique.slice().reverse())];
}

export function birdFocusView(geometry, { aspect = 1, direction = new Vector3(0, 1, 1e-6), padding: { horizontal = .78, vertical = .78 } = {} } = {}) {
    if (!geometry.points.length) return null;
    const hull = footprintHull(geometry.points), center = geometry.box.getCenter(new Vector3());
    const current = -Math.atan2(direction.x, direction.z);
    const size = geometry.box.getSize(new Vector3());
    const footprint = Math.hypot(size.x, size.z);
    const minimum = (footprint || size.y * .08 || 1) * .05;
    const fit = heading => {
        const theta = -heading, right = new Vector3(Math.cos(theta), 0, -Math.sin(theta));
        const north = new Vector3(-Math.sin(theta), 0, -Math.cos(theta));
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const point of hull) {
            const offset = new Vector3(point.x - center.x, 0, point.y - center.z);
            const x = offset.dot(right), y = offset.dot(north);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        const span = Math.max((maxX - minX) / (2 * aspect * horizontal), (maxY - minY) / (2 * vertical), minimum);
        const motion = Math.abs(angleDelta(heading, current));
        return { heading, span, right, north, x: (minX + maxX) / 2, y: (minY + maxY) / 2, cost: span * (1 + .04 * Math.pow(motion / (Math.PI / 2), 2)) };
    };
    let best = fit(current);
    for (let degrees = -90; degrees <= 90; degrees += 5) {
        const candidate = fit(current + degrees * radians);
        if (candidate.cost < best.cost) best = candidate;
    }
    const coarse = best.heading;
    for (let degrees = -5; degrees <= 5; degrees += .5) {
        const candidate = fit(coarse + degrees * radians);
        if (candidate.cost < best.cost) best = candidate;
    }
    const unchanged = fit(current);
    if (unchanged.span <= best.span * 1.08) best = unchanged;
    const target = center.addScaledVector(best.right, best.x).addScaledVector(best.north, best.y);
    // Height affects camera clearance, not the orthographic footprint zoom.
    const span = best.span + size.y * 1e-6;
    const distance = Math.max(size.y / 2 + span * 2, span * 3);
    return { target: target.toArray(), position: target.clone().add(new Vector3(...orbitOffset(distance, best.heading / radians, 90))).toArray(), span };
}
