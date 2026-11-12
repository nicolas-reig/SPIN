import * as THREE from 'three';
import { TransformTransaction, transformDelta, axisVector, selectionCenter } from './transform-math.js';
import { TransformInput } from './transform-input.js';

const axes = ['X', 'Y', 'Z'];
const unit = () => new THREE.Vector3(1, 1, 1);
const round = (value, step) => Math.round(value / step) * step;
const objectOrientation = object => {
    const chain = [];
    for (let node = object; node; node = node.parent) chain.unshift(node.quaternion);
    return chain.reduce((value, quaternion) => value.multiply(quaternion), new THREE.Quaternion()).normalize();
};

// The controller owns only temporary handles and object previews. EditSession is
// changed once, after confirmation, so a whole selection is one undo operation.
export class TransformController {
    constructor({ scene, camera, canvas, controls, onChange, onCommit, onError, onPreview = () => {} }) {
        Object.assign(this, { scene, camera, canvas, controls, onChange, onCommit, onError, onPreview });
        this.entries = []; this.mode = ''; this.space = 'world'; this.constraint = ''; this.snap = false;
        this.group = new THREE.Group(); this.group.name = 'Transform gizmos'; this.group.visible = false;
        scene.add(this.group);
        this.colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
        this.abort = new AbortController();
        const listen = (target, type, callback, capture = false) => target.addEventListener(type, callback, { capture, signal: this.abort.signal });
        listen(canvas, 'pointerdown', event => this.pointerDown(event), true);
        listen(canvas, 'pointermove', event => this.pointerMove(event), true);
        listen(canvas, 'pointerup', event => this.pointerUp(event), true);
        listen(canvas, 'pointercancel', () => this.cancel(), true);
        listen(canvas, 'lostpointercapture', () => { if (this.active && !this.active.modal) this.cancel(); });
        listen(canvas, 'contextmenu', event => { if (this.active) { event.preventDefault(); this.cancel(); } }, true);
        listen(window, 'pointermove', event => { this.pointer = { x: event.clientX, y: event.clientY }; });
        listen(window, 'blur', () => this.cancel());
        listen(document, 'visibilitychange', () => { if (document.hidden) this.cancel(); });
        listen(canvas, 'wheel', event => { if (this.active) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
        listen(document, 'keyup', event => { if (this.active && ['Shift', 'Control'].includes(event.key)) this.preview(event); });
    }

    setSelection(entries) {
        this.cancel(); this.entries = entries; this.rebuild();
    }
    configure(mode, snap, space = 'world', constraint = '') {
        if (mode !== this.mode || space !== this.space || constraint !== this.constraint) this.cancel();
        const rebuild = mode !== this.mode;
        Object.assign(this, { mode, snap, space, constraint });
        if (rebuild) this.rebuild();
        this.update(); this.onChange();
    }
    setColors(...colors) { this.colors = colors; this.rebuild(); }
    clearHandles() {
        this.group.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
        this.group.clear();
    }
    rebuild() {
        this.clearHandles();
        const material = (axis, opacity = 1) => new THREE.MeshBasicMaterial({ color: this.colors[axes.indexOf(axis)] || this.colors[3],
            depthTest: false, depthWrite: false, transparent: true, opacity, side: THREE.DoubleSide });
        const add = (geometry, mode, axis, position, quaternion, opacity) => {
            const mesh = new THREE.Mesh(geometry, material(axis, opacity));
            mesh.userData = { mode, axis }; mesh.renderOrder = 10000;
            if (position) mesh.position.copy(position);
            if (quaternion) mesh.quaternion.copy(quaternion);
            this.group.add(mesh); return mesh;
        };
        const combined = this.mode === 'combined';
        for (const axis of axes) {
            const direction = axisVector(axis);
            const upright = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
            if (combined || this.mode === 'translate') {
                add(new THREE.CylinderGeometry(.012, .012, .72, 8), 'translate', axis, direction.clone().multiplyScalar(.48), upright);
                add(new THREE.ConeGeometry(.065, .18, 12), 'translate', axis, direction.clone().multiplyScalar(.93), upright);
            }
            if (combined || this.mode === 'scale') {
                const end = combined ? 1.28 : 1;
                if (!combined) add(new THREE.CylinderGeometry(.012, .012, .8, 8), 'scale', axis, direction.clone().multiplyScalar(.5), upright);
                add(new THREE.BoxGeometry(.1, .1, .1), 'scale', axis, direction.clone().multiplyScalar(end));
            }
            if (combined || this.mode === 'rotate') {
                const normal = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
                add(new THREE.TorusGeometry(combined ? .68 : .88, .012, 8, 80), 'rotate', axis, null, normal);
            }
        }
        if (this.mode === 'translate') {
            for (const plane of ['XY', 'YZ', 'XZ']) {
                const missing = axes.find(axis => !plane.includes(axis));
                const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axisVector(missing));
                add(new THREE.PlaneGeometry(.19, .19), 'translate', plane,
                    axisVector(plane[0]).add(axisVector(plane[1])).multiplyScalar(.29), q, .35);
            }
            add(new THREE.SphereGeometry(.07, 12, 8), 'translate', 'XYZ');
        }
        if (combined || this.mode === 'scale') add(new THREE.BoxGeometry(.13, .13, .13), 'scale', 'XYZ');
        if (this.mode === 'rotate') {
            this.viewRing = add(new THREE.TorusGeometry(1.08, .014, 8, 96), 'rotate', 'E');
            this.trackball = add(new THREE.SphereGeometry(.16, 16, 12), 'rotate', 'TRACKBALL', null, null, .35);
        } else this.viewRing = this.trackball = null;
        this.update(); this.onChange();
    }

    orientation() {
        return this.space === 'local' && this.entries.length ? objectOrientation(this.entries[0].object) : new THREE.Quaternion();
    }
    worldPerPixel(center = this.group.position) {
        const height = this.canvas.getBoundingClientRect().height || 1;
        if (this.camera.isOrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / height;
        const depth = Math.max(this.camera.near, -center.clone().applyMatrix4(this.camera.matrixWorldInverse).z);
        return 2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.camera.zoom / height;
    }
    update() {
        this.group.visible = Boolean(this.mode && this.entries.length);
        if (!this.group.visible) return;
        if (!this.active) {
            this.group.position.copy(selectionCenter(this.entries));
            this.group.quaternion.copy(this.orientation());
        }
        this.group.scale.setScalar(this.worldPerPixel() * 88);
        if (this.viewRing) this.viewRing.quaternion.copy(this.group.quaternion).invert().multiply(this.camera.quaternion);
        for (const child of this.group.children) {
            const axis = child.userData.axis;
            child.visible = !this.constraint || axis.length > 1 || axis === this.constraint;
        }
        this.group.updateMatrixWorld(true);
    }
    ray(event) {
        const rect = this.canvas.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.camera);
        return ray;
    }
    pick(event) {
        this.update();
        if (!this.group.visible) return null;
        return this.ray(event).intersectObjects(this.group.children.filter(child => child.visible), false)[0]?.object.userData;
    }
    consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    pointerDown(event) {
        if (this.active) {
            this.consume(event);
            if (event.button === 2) this.cancel();
            else if (event.button === 0 && this.active.modal) this.confirm();
            return;
        }
        if (event.button !== 0) return;
        const hit = this.pick(event);
        if (!hit) return;
        this.consume(event); this.canvas.focus({ preventScroll: true });
        this.begin(hit.mode, event, { axis: hit.axis, modal: false });
        this.canvas.setPointerCapture(event.pointerId);
        this.active.pointerId = event.pointerId;
    }
    pointerMove(event) {
        if (!this.active) {
            this.canvas.style.cursor = this.pick(event) ? 'crosshair' : '';
            return;
        }
        this.consume(event);
        const active = this.active;
        const precision = event.shiftKey ? .1 : 1;
        active.dx += (event.clientX - active.last.x) * precision;
        active.dy += (event.clientY - active.last.y) * precision;
        active.last = { x: event.clientX, y: event.clientY };
        this.preview(event);
    }
    pointerUp(event) {
        if (!this.active) return;
        this.consume(event);
        if (!this.active.modal && event.button === 0) {
            if (!this.confirm()) this.cancel();
        }
    }

    begin(mode, event = {}, { axis = '', modal = true } = {}) {
        this.cancel();
        if (!this.entries.length || !this.mode) return false;
        const transaction = new TransformTransaction(this.entries);
        const rect = this.canvas.getBoundingClientRect();
        const pointer = { x: event.clientX ?? this.pointer?.x ?? rect.left + rect.width / 2,
            y: event.clientY ?? this.pointer?.y ?? rect.top + rect.height / 2 };
        const projected = transaction.center.clone().project(this.camera);
        const center = { x: rect.left + (projected.x + 1) * rect.width / 2, y: rect.top + (1 - projected.y) * rect.height / 2 };
        const viewAxis = this.camera.getWorldDirection(new THREE.Vector3()).negate();
        this.active = { transaction, mode, axis: axis || this.constraint, modal, start: pointer, last: pointer, center,
            dx: 0, dy: 0, input: new TransformInput(), orientation: this.orientation(),
            localOrientation: objectOrientation(this.entries[0].object), viewAxis, lock: 0, error: null,
            oldControls: this.controls.enabled, worldPerPixel: this.worldPerPixel(transaction.center) };
        this.controls.enabled = false;
        this.canvas.dataset.transform = mode;
        this.canvas.focus({ preventScroll: true });
        this.group.position.copy(transaction.center); this.group.quaternion.copy(this.active.orientation);
        this.preview(event); return true;
    }

    key(event) {
        const active = this.active;
        if (!active) return false;
        if (event.key === 'Escape') this.cancel();
        else if (event.key === 'Enter') this.confirm();
        else if (event.key === 'Shift' || event.key === 'Control') this.preview(event);
        else if (active.input.advanced && active.input.key(event)) this.preview(event);
        else if (!event.metaKey && !event.ctrlKey && axes.includes(event.key.toUpperCase())) {
            const axis = event.key.toUpperCase();
            const next = event.shiftKey ? axes.filter(value => value !== axis).join('') : axis;
            active.lock = active.axis === next ? (active.lock + 1) % 3 : 1;
            active.axis = active.lock ? next : '';
            active.orientation = active.lock === 2 ? active.localOrientation.clone() : new THREE.Quaternion();
            this.preview(event);
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && ['g', 'r', 's'].includes(event.key.toLowerCase())) {
            const mode = { g: 'translate', r: 'rotate', s: 'scale' }[event.key.toLowerCase()];
            if (mode === 'rotate' && active.mode === 'rotate') {
                active.axis = active.axis === 'TRACKBALL' ? '' : 'TRACKBALL'; this.preview(event);
            } else this.begin(mode, { clientX: active.last.x, clientY: active.last.y });
        } else if (active.input.key(event)) this.preview(event);
        else return true; // Modal editing owns viewport keys, including undo and camera keys.
        return true;
    }

    screenAxis(axis, active) {
        const rect = this.canvas.getBoundingClientRect();
        const origin = active.transaction.center.clone().project(this.camera);
        const end = active.transaction.center.clone().add(axisVector(axis).applyQuaternion(active.orientation)).project(this.camera);
        return new THREE.Vector2((end.x - origin.x) * rect.width / 2, -(end.y - origin.y) * rect.height / 2);
    }
    translation(active) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const movement = right.multiplyScalar(active.dx * active.worldPerPixel).addScaledVector(up, -active.dy * active.worldPerPixel);
        const axis = active.axis;
        if (axes.includes(axis)) {
            const projected = this.screenAxis(axis, active);
            const amount = projected.lengthSq() > 1e-6 ? new THREE.Vector2(active.dx, active.dy).dot(projected) / projected.lengthSq() : -active.dy * active.worldPerPixel;
            return axisVector(axis).applyQuaternion(active.orientation).multiplyScalar(amount);
        }
        if (axis.length === 2) {
            const normal = axisVector(axes.find(value => !axis.includes(value))).applyQuaternion(active.orientation);
            // Ray/plane movement keeps each visible plane handle under the pointer.
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, active.transaction.center);
            const start = this.ray({ clientX: active.start.x, clientY: active.start.y }).ray.intersectPlane(plane, new THREE.Vector3());
            const end = this.ray({ clientX: active.start.x + active.dx, clientY: active.start.y + active.dy }).ray.intersectPlane(plane, new THREE.Vector3());
            return start && end ? end.sub(start) : movement.addScaledVector(normal, -movement.dot(normal));
        }
        return movement;
    }

    preview(event = {}) {
        const a = this.active;
        if (!a) return;
        const { input, axis, orientation, transaction } = a;
        const values = input.values(a.mode === 'scale' ? 1 : 0);
        const selectedAxes = axis.length <= 2 && axis ? axes.filter(value => axis.includes(value)) : axes;
        const snapping = this.snap || event.ctrlKey;
        try {
            if (input.used && values.some(value => !Number.isFinite(value))) throw Error('transformNumber');
            let translation = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = unit();
            if (a.mode === 'translate') {
                translation = this.translation(a);
                if (input.used) {
                    if (input.separate) translation.set(...values).applyQuaternion(orientation);
                    else if (axis && axis.length <= 2) translation.set(...axes.map(value => selectedAxes.includes(value) ? values[0] : 0)).applyQuaternion(orientation);
                    else translation = (translation.lengthSq() ? translation.normalize() : axisVector('X')).multiplyScalar(values[0]);
                }
                if (snapping && !input.used) {
                    translation.applyQuaternion(orientation.clone().invert());
                    translation.set(...translation.toArray().map(value => round(value, 1))).applyQuaternion(orientation);
                }
            } else if (a.mode === 'rotate') {
                let rotationAxis = axes.includes(axis) ? axisVector(axis).applyQuaternion(orientation) : a.viewAxis;
                if (axis.length === 2) rotationAxis = axisVector(axes.find(value => !axis.includes(value))).applyQuaternion(orientation);
                let angle;
                const sx = a.start.x - a.center.x, sy = a.start.y - a.center.y;
                const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(rotationAxis, transaction.center);
                const start = this.ray({ clientX: a.start.x, clientY: a.start.y }).ray.intersectPlane(plane, new THREE.Vector3());
                const end = this.ray({ clientX: a.start.x + a.dx, clientY: a.start.y + a.dy }).ray.intersectPlane(plane, new THREE.Vector3());
                if (start && end && start.distanceToSquared(transaction.center) > 1e-8 && Math.hypot(sx, sy) > 15) {
                    start.sub(transaction.center).normalize(); end.sub(transaction.center).normalize();
                    angle = Math.atan2(rotationAxis.dot(start.clone().cross(end)), start.dot(end));
                } else if (Math.hypot(sx, sy) > 15) {
                    angle = Math.atan2(-sy - a.dy, sx + a.dx) - Math.atan2(-sy, sx);
                    if (rotationAxis.dot(a.viewAxis) < 0) angle *= -1;
                } else angle = (a.dx - a.dy) * .01;
                if (input.used) angle = THREE.MathUtils.degToRad(values[0]);
                else if (snapping) angle = round(angle, Math.PI / 12);
                if (axis === 'TRACKBALL' && !input.used) {
                    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
                    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
                    rotation.setFromAxisAngle(up, a.dx * .01).multiply(new THREE.Quaternion().setFromAxisAngle(right, a.dy * .01));
                } else rotation.setFromAxisAngle(rotationAxis, angle);
            } else {
                let amount;
                if (axes.includes(axis)) {
                    const projected = this.screenAxis(axis, a).normalize();
                    amount = 1 + new THREE.Vector2(a.dx, a.dy).dot(projected) / 88;
                } else {
                    const radial = new THREE.Vector2(a.start.x - a.center.x, a.start.y - a.center.y);
                    amount = 1 + (radial.length() > 15 ? new THREE.Vector2(a.dx, a.dy).dot(radial.clone().normalize()) / Math.max(60, radial.length()) : (a.dx - a.dy) / 100);
                }
                if (snapping && !input.used) amount = round(amount, .1);
                scale.set(...axes.map((value, index) => selectedAxes.includes(value) ? input.used ? values[input.separate ? index : 0] : amount : 1));
            }
            const changes = transaction.apply(transformDelta(transaction.center, { translation, rotation, scale, orientation }));
            a.error = null;
            this.group.position.copy(transaction.center).add(translation);
            this.group.quaternion.copy(rotation).multiply(orientation);
            this.onPreview(changes);
        } catch (error) { a.error = error.message; }
        this.onChange();
    }

    finish() {
        const active = this.active;
        this.active = null;
        this.controls.enabled = active.oldControls;
        delete this.canvas.dataset.transform;
        if (active.pointerId != null && this.canvas.hasPointerCapture(active.pointerId)) this.canvas.releasePointerCapture(active.pointerId);
        this.update(); this.onChange(); return active;
    }
    confirm() {
        if (!this.active) return false;
        if (this.active.error) { this.onError(this.active.error); return false; }
        const changed = this.active.transaction.entries.some(({ object, position, quaternion, scale }) =>
            object.position.distanceToSquared(position) > 1e-20 || 1 - Math.abs(object.quaternion.dot(quaternion)) > 1e-12 || object.scale.distanceToSquared(scale) > 1e-20);
        const changes = this.active.transaction.changes();
        this.finish();
        if (changed) this.onCommit(changes);
        return true;
    }
    cancel() {
        if (!this.active) return false;
        this.active.transaction.restore(); this.onPreview(this.active.transaction.changes()); this.finish(); return true;
    }
    dispose() {
        this.cancel(); this.abort.abort(); this.clearHandles(); this.scene.remove(this.group); this.canvas.style.cursor = '';
    }
}
