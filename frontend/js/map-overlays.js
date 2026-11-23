import { Vector3, WebGPUCoordinateSystem } from 'three';
import { groupExhibits } from './exhibit-groups.js';
import { lang } from './locale.js';
import { componentMedian } from './transform-math.js';

export class MapOverlays {
    items = new Map();
    hitTargets = [];
    projected = new Vector3();
    dirty = true;

    constructor(container, select) {
        this.layer = document.createElement('div');
        this.layer.className = 'map-overlays';
        container.append(this.layer);
        this.select = select;
    }

    invalidate() { this.dirty = true; }

    updateAnchors(exhibits, objects, circles, labels) {
        const centers = new Map();
        const placed = [];
        for (const record of exhibits) {
            const object = objects.get(record.id);
            if (!object) continue;
            object.updateWorldMatrix(true, false);
            const center = componentMedian(object).applyMatrix4(object.matrixWorld);
            if (!center.toArray().every(Number.isFinite)) continue;
            centers.set(record.id, center);
            placed.push(record);
        }
        const next = new Map();
        const add = (key, center, create) => {
            const element = this.items.get(key)?.element || create();
            if (!element.parentNode) this.layer.append(element);
            next.set(key, { center, element });
            return element;
        };

        if (labels) for (const group of groupExhibits(placed, lang())) {
            if (!group.key) continue;
            const center = new Vector3();
            for (const record of group.records) center.add(centers.get(record.id));
            center.divideScalar(group.records.length);
            const label = add(`group:${group.key}`, center, () => {
                const span = document.createElement('span');
                span.className = 'map-group-label';
                span.dataset.mapGroup = group.key;
                return span;
            });
            if (label.textContent !== group.name) label.textContent = group.name;
        }
        if (circles) for (const record of placed) {
            const button = add(`circle:${record.id}`, centers.get(record.id), () => {
                const control = document.createElement('button');
                control.type = 'button';
                control.className = 'map-top-circle';
                control.dataset.mapCircle = record.id;
                // Pointer selection stays with the canvas to preserve pan and pinch gestures.
                control.addEventListener('click', event => this.select(record.id, event.shiftKey));
                return control;
            });
            button.setAttribute('aria-label', record.name);
            button.dataset.status = record.status;
        }
        for (const [key, { element }] of this.items) if (!next.has(key)) element.remove();
        this.items = next;
        this.circles = circles;
        this.labels = labels;
        this.dirty = false;
    }

    render({ camera, width, height, viewport, exhibits, objects, selection, circles, labels }) {
        this.hitTargets.length = 0;
        this.layer.hidden = !circles && !labels;
        if (this.layer.hidden || !width || !height) return;
        if (this.dirty || circles !== this.circles || labels !== this.labels) this.updateAnchors(exhibits, objects, circles, labels);
        if (!this.items.size) return;

        camera.updateMatrixWorld();
        const diameter = Math.max(44, Math.min(56, Math.min(width, height) * .06));
        this.radius = diameter / 2;
        this.layer.style.setProperty('--map-circle-diameter', `${diameter}px`);
        this.layer.classList.toggle('with-top-circles', circles);
        const near = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
        for (const { center, element } of this.items.values()) {
            const point = this.projected.copy(center).project(camera);
            element.hidden = !(point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1 && point.z >= near && point.z <= 1);
            if (element.hidden) continue;
            const x = (point.x + 1) * width / 2, y = (1 - point.y) * height / 2;
            element.style.translate = `${x}px ${y}px`;
            const id = element.dataset.mapCircle;
            if (id === undefined) continue;
            const pressed = String(selection.has(id));
            if (element.getAttribute('aria-pressed') !== pressed) element.setAttribute('aria-pressed', pressed);
            element.tabIndex = !viewport || (point.x >= viewport.left && point.x <= viewport.right &&
                point.y >= viewport.bottom && point.y <= viewport.top) ? 0 : -1;
            this.hitTargets.push({ id, x, y });
        }
    }

    pick(x, y) {
        let best = this.radius ** 2, id = null;
        for (const target of this.hitTargets) {
            const distance = (target.x - x) ** 2 + (target.y - y) ** 2;
            if (distance >= best) continue;
            best = distance;
            id = target.id;
        }
        return id;
    }

    destroy() { this.layer.remove(); }
}
