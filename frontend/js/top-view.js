import {
    AddEquation, BufferAttribute, BufferGeometry, Color, CustomBlending, DoubleSide,
    HalfFloatType, Mesh, MeshBasicNodeMaterial, NearestFilter, OneFactor, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, Vector2, Vector3
} from 'three';
import { attribute, Discard, float, Fn, frontFacing, If, mix, positionWorld, screenUV, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl';

function closedGeometry(geometry) {
    const position = geometry.attributes.position;
    const index = geometry.index;
    const vertices = new Map();
    const welded = new Uint32Array(position.count);
    for (let i = 0; i < position.count; i++) {
        const key = [position.getX(i), position.getY(i), position.getZ(i)].map(value => Math.round(value * 1e5)).join(',');
        if (!vertices.has(key)) vertices.set(key, vertices.size);
        welded[i] = vertices.get(key);
    }
    const edges = new Map();
    for (let i = 0; i < (index?.count ?? position.count); i += 3) {
        const [a, b, c] = [0, 1, 2].map(offset => welded[index ? index.getX(i + offset) : i + offset]);
        if (a === b || b === c || c === a) continue;
        for (const [from, to] of [[a, b], [b, c], [c, a]]) {
            const key = from < to ? `${from}:${to}` : `${to}:${from}`;
            edges.set(key, (edges.get(key) ?? 0) + (from < to ? 1 : -1));
        }
    }
    return edges.size > 0 && [...edges.values()].every(balance => balance === 0);
}

function projectionGeometry(building, meshes, closed, cutHeight) {
    const count = meshes.reduce((sum, { geometry }) => sum + (geometry.index?.count ?? geometry.attributes.position.count), 0);
    if (!count || meshes.some(mesh => mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.morphTargetInfluences?.some(Boolean))) return null;
    building.updateWorldMatrix(true, true);
    const positions = new Float32Array(count * 3);
    const solids = new Float32Array(count);
    const point = new Vector3();
    const ranges = [];
    let cursor = 0;
    for (const mesh of meshes) {
        const { geometry, matrixWorld } = mesh;
        const { index, attributes: { position } } = geometry;
        if (!closed.has(geometry)) closed.set(geometry, closedGeometry(geometry));
        const end = index?.count ?? position.count;
        if (closed.get(geometry)) solids.fill(1, cursor, cursor + end);
        const start = cursor;
        let low = Infinity, high = -Infinity;
        const mirrored = matrixWorld.determinant() < 0;
        for (let i = 0; i < end; i++) {
            const corner = i % 3;
            const vertex = mirrored && corner ? i + 3 - 2 * corner : i;
            point.fromBufferAttribute(position, index ? index.getX(vertex) : vertex).applyMatrix4(matrixWorld).toArray(positions, cursor++ * 3);
            low = Math.min(low, point.y);
            high = Math.max(high, point.y);
        }
        ranges.push({ start, end: cursor, low, high });
    }

    // The largest horizontal surface gives each floor its own height reference.
    const levels = new Map();
    for (let i = 0; i < positions.length; i += 9) {
        const y = positions[i + 1];
        if (Math.abs(y - positions[i + 4]) > .01 || Math.abs(y - positions[i + 7]) > .01) continue;
        const area = (positions[i + 5] - positions[i + 2]) * (positions[i + 6] - positions[i]) -
            (positions[i + 3] - positions[i]) * (positions[i + 8] - positions[i + 2]);
        if (area <= 0) continue;
        const level = Math.round(y * 20) / 20;
        levels.set(level, (levels.get(level) ?? 0) + area);
    }
    let height = 0, largestArea = 0;
    for (const [level, area] of levels) {
        if (area > largestArea) { height = level; largestArea = area; }
    }
    if (cutHeight !== null) {
        const plane = height + cutHeight;
        // Surfaces wholly above or below the cut cannot contribute a wall cap.
        for (const range of ranges) if (range.low >= plane || range.high < plane) solids.fill(-1, range.start, range.end);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('closed', new BufferAttribute(solids, 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return { geometry, height };
}

function target(depthBuffer) {
    return new RenderTarget(1, 1, { type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer });
}

export class TopView {
    static supported(renderer) {
        if (!renderer.backend.isWebGLBackend) return true;
        return renderer.backend.extensions.has('EXT_color_buffer_float') || renderer.backend.extensions.has('EXT_color_buffer_half_float');
    }

    constructor() {
        this.surface = target(true);
        this.columns = target(false);
        this.reference = uniform(0);
        this.useThickness = uniform(0);
        this.section = uniform(0);
        this.cutHeight = uniform(1.1);
        this.step = uniform(new Vector2());
        this.closed = new WeakMap();
        this.size = new Vector2();
        this.direction = new Vector3();
        this.toCenter = new Vector3();
        this.projectionCamera = new OrthographicCamera();
        this.clearColor = new Color();
        this.projection = new Scene();
        this.surfaceMaterial = new MeshBasicNodeMaterial({ side: DoubleSide, toneMapped: false });
        const height = positionWorld.y.sub(this.reference);
        const aboveCut = height.greaterThanEqual(this.cutHeight);
        const cutting = this.section.greaterThan(.5);
        const clip = () => {
            If(cutting.and(aboveCut), () => { Discard(); });
        };
        this.surfaceMaterial.fragmentNode = Fn(() => {
            clip();
            return vec4(height, 0, 0, 1);
        })();
        this.columnMaterial = new MeshBasicNodeMaterial({
            side: DoubleSide, toneMapped: false, transparent: true, forceSinglePass: true,
            depthTest: false, depthWrite: false, blending: CustomBlending,
            blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor
        });
        // The signed sum gives material length, or occupancy when counting faces above the cut.
        const direction = frontFacing.select(1, -1);
        const contribution = cutting.select(aboveCut.select(1, 0), height).mul(direction);
        const closure = attribute('closed', 'float');
        const solid = closure.equal(1).select(1, 0);
        const open = closure.equal(0).select(1, 0);
        this.columnMaterial.fragmentNode = vec4(contribution.mul(solid), contribution.mul(open), direction.mul(open), 1);

        const surface = texture(this.surface.texture, screenUV);
        const column = texture(this.columns.texture, screenUV);
        // Keep known solid contributions even where an open surface has no matching exit.
        const columnSum = column.r.max(0).add(column.b.abs().lessThan(.5).select(column.g.max(0), 0));
        const amount = float(1).sub(columnSum.mul(-1.1).exp());
        const lift = smoothstep(.025, 1.35, surface.r);
        const fill = mix(lift.mul(.53), amount.mul(.93).max(lift.mul(.44)), this.useThickness);
        let edge = float(0);
        for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const adjacent = texture(this.surface.texture, screenUV.add(this.step.mul(vec2(x, y))));
            const contrast = smoothstep(.10, .36, surface.r.sub(adjacent.r).abs());
            edge = edge.max(adjacent.a.lessThan(.5).select(1, contrast));
        }
        this.material = new MeshBasicNodeMaterial({ side: DoubleSide, toneMapped: false });
        const paper = uniform(new Color('#f6f7f8'));
        const ink = uniform(new Color('#5e6871'));
        const outline = uniform(new Color('#6c7680'));
        this.material.fragmentNode = Fn(() => {
            clip();
            return vec4(mix(mix(paper, ink, fill), outline, edge.mul(.62)), 1);
        })();
        const capMaterial = new MeshBasicNodeMaterial({ side: DoubleSide, toneMapped: false });
        capMaterial.fragmentNode = Fn(() => {
            // Winding above the plane is positive only where the section crosses a solid.
            If(columnSum.lessThan(.5), () => { Discard(); });
            return vec4(ink, 1);
        })();
        this.cap = new Mesh(new PlaneGeometry(1, 1), capMaterial);
        this.cap.rotation.x = -Math.PI / 2;
        this.mesh = new Mesh(new BufferGeometry(), this.surfaceMaterial);
        this.projection.add(this.mesh);
    }

    prepare(building, cutHeight) {
        if (this.building === building && this.preparedCut === cutHeight) return;
        this.clear();
        this.building = building;
        this.preparedCut = cutHeight;
        building.traverseVisible(mesh => { if (mesh.isMesh) this.meshes.push(mesh); });
        const projected = projectionGeometry(building, this.meshes, this.closed, cutHeight);
        this.ready = Boolean(projected);
        if (!projected) return;
        this.mesh.geometry = projected.geometry;
        this.reference.value = projected.height;
        if (cutHeight !== null) {
            const { min, max } = projected.geometry.boundingBox;
            this.cap.position.set((min.x + max.x) / 2, projected.height + cutHeight, (min.z + max.z) / 2);
            this.cap.scale.set(max.x - min.x, max.z - min.z, 1);
        }
    }

    render(renderer, scene, camera, building, style, cutHeight = 1.1) {
        const isSection = style === 'section';
        this.section.value = isSection ? 1 : 0;
        this.cutHeight.value = cutHeight;
        this.prepare(building, isSection ? cutHeight : null);
        if (!this.ready) return false;
        const { x, y } = renderer.getSize(this.size);
        if (!x || !y) return false;
        const scale = Math.min(1, 2048 / Math.max(x, y));
        const width = Math.max(1, Math.round(x * scale));
        const height = Math.max(1, Math.round(y * scale));
        this.useThickness.value = style === 'thickness' ? 1 : 0;
        camera.updateMatrixWorld();
        const key = [width, height, style, ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements].join(',');
        if (key !== this.key) {
            this.surface.setSize(width, height);
            this.columns.setSize(width, height);
            this.step.value.set(1 / width, 1 / height);
            // Move the sampling camera back along its axis so zoom and saved views cannot clip the column.
            const projectionCamera = this.projectionCamera.copy(camera);
            const { center, radius } = this.mesh.geometry.boundingSphere;
            const distance = this.toCenter.copy(center).sub(camera.position).dot(camera.getWorldDirection(this.direction));
            const retreat = Math.max(0, radius - distance + 1);
            projectionCamera.translateZ(retreat);
            projectionCamera.near = .05;
            projectionCamera.far = Math.max(1, distance + retreat + radius + 1);
            projectionCamera.updateProjectionMatrix();
            const previousTarget = renderer.getRenderTarget();
            const clearAlpha = renderer.getClearAlpha();
            renderer.getClearColor(this.clearColor);
            try {
                renderer.setClearColor(0, 0);
                renderer.setRenderTarget(this.surface);
                this.mesh.material = this.surfaceMaterial;
                renderer.render(this.projection, projectionCamera);
                renderer.setRenderTarget(this.columns);
                if (this.useThickness.value || isSection) {
                    this.mesh.material = this.columnMaterial;
                    renderer.render(this.projection, projectionCamera);
                } else {
                    renderer.clear();
                }
                this.key = key;
            } finally {
                renderer.setRenderTarget(previousTarget);
                renderer.setClearColor(this.clearColor, clearAlpha);
            }
        }

        const original = this.meshes.map(mesh => mesh.material);
        try {
            for (const mesh of this.meshes) mesh.material = this.material;
            if (isSection) scene.add(this.cap);
            renderer.render(scene, camera);
        } finally {
            if (isSection) scene.remove(this.cap);
            this.meshes.forEach((mesh, index) => { mesh.material = original[index]; });
        }
        return true;
    }

    clear() {
        this.mesh.geometry.dispose();
        this.mesh.geometry = new BufferGeometry();
        this.meshes = [];
        this.building = null;
        this.key = null;
        this.ready = false;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.surface.dispose();
        this.columns.dispose();
        this.surfaceMaterial.dispose();
        this.columnMaterial.dispose();
        this.material.dispose();
        this.cap.geometry.dispose();
        this.cap.material.dispose();
    }
}
