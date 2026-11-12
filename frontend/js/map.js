import * as THREE from 'three';
import {
    GLTFLoader
} from 'three/addons/loaders/GLTFLoader.js';
import {
    OrbitControls
} from 'three/addons/controls/OrbitControls.js';
import { TransformController } from './transform-controller.js';
import { transformKey, TransformTransaction, selectionFieldDelta } from './transform-math.js';
import { coordinateNumber, coordinateVector } from './domain.js';

import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { cameraMode, cameraOffset, navigationGesture, orbitState, orbitOffset, viewKey } from './camera.js';
import { colorMode, colorScheme, onColorModeChange } from './colors.js';
import { TopView } from './top-view.js';
import { dispose, disposeMaterials, replaceMaterials } from './model-resources.js';
import { boundsScale, boundsCorners, aimCamera, frameBounds, controlLimits, clippingPlanes, clearViewport } from './camera-framing.js';
import { focusGeometry, nextBestView, birdFocusView } from './camera-focus.js';

const radians = v => v * Math.PI / 180;

function applyTransform(object, t) {
    object.position.fromArray(t.position);
    object.rotation.set(...t.rotation.map(radians));
    object.scale.fromArray(t.scale);
}

function smoothNormals(object) {
    const geometries = new Map();
    let shareable = true;
    object.traverse(mesh => {
        if (!mesh.isMesh) return;
        if (mesh.isSkinnedMesh) shareable = false;
        const original = mesh.geometry;
        if (!geometries.has(original)) {
            geometries.set(original, toCreasedNormals(original, Math.PI / 6));
        }
        mesh.geometry = geometries.get(original);
    });
    for (const [original, smoothed] of geometries) {
        if (original !== smoothed) original.dispose();
    }
    return shareable;
}
export class MapView {
    constructor(container, {
        onSelect = () => {},
        onTransform = () => {},
        onInvalidTransform = () => {},
        onTransformPreview = () => {},
        onState = () => {},
        onMode = () => {},
        onCamera = () => {}
    } = {}) {
        this.container = container;
        this.onSelect = onSelect;
        this.onTransform = onTransform;
        this.onInvalidTransform = onInvalidTransform;
        this.onTransformPreview = onTransformPreview;
        this.onState = onState;
        this.onMode = onMode;
        this.onCamera = onCamera;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#e8edf0');
        this.root = new THREE.Group();
        this.scene.add(this.root);
        this.boundsDirty = true;
        this.objects = new Map();
        this.materials = Object.fromEntries(Object.entries(colorScheme().materials).map(([name, color]) => {
            const material = new THREE.MeshStandardMaterial({
                color,
                roughness: .9,
                metalness: 0,
                side: THREE.DoubleSide
            });
            material.name = name;
            return [name, material];
        }));
        this.sharedMaterials = new Set(Object.values(this.materials));
        this.stopColorUpdates = onColorModeChange(() => this.updateColors());
        this.generation = 0;
        this.mode = 'perspective';
        this.selected = null;
        this.selection = new Set();
        this.hardwareSelection = [];
        this.frame = 0;
        this.snap = false;
        this.loader = new GLTFLoader();
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x77899b, 2.5));
        const light = new THREE.DirectionalLight(0xffffff, 2.6);
        light.position.set(25, 55, 35);
        this.scene.add(light);
        this.camera = new THREE.PerspectiveCamera(38, 1, .05, 2000);
        this.camera.position.set(28, 27, 33);
    }
    async init() {
        const params = new URLSearchParams(location.search);
        if (params.has('no3d')) throw Error('mapUnavailable');
        const style = params.get('map2d');
        this.topStyle = ['shaded', 'height', 'thickness'].includes(style) ? style : 'thickness';
        this.renderer = new THREE.WebGPURenderer({
            antialias: true,
            forceWebGL: params.has('webgl')
        });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.toneMapping = THREE.NeutralToneMapping;
        this.renderer.toneMappingExposure = 1;
        await this.renderer.init();
        this.renderer.domElement.dataset.renderer = this.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
        this.container.append(this.renderer.domElement);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = false;
        this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE };
        this.controls.keys = { LEFT: 'ArrowRight', UP: 'ArrowDown', RIGHT: 'ArrowLeft', BOTTOM: 'ArrowUp' };
        this.updateCameraLimits();
        this.controls.maxPolarAngle = Math.PI / 2;
        this.controls.minPolarAngle = .000001;
        this.controls.addEventListener('change', () => {
            if (this.boundsDirty || this.cameraLimitsDirty) this.updateCameraLimits();
            else this.updateCameraClipping();
            this.requestRender();
        });
        this.controls.addEventListener('start', () => cancelAnimationFrame(this.cameraFrame));
        this.transform = new TransformController({
            scene: this.scene, camera: this.camera, canvas: this.renderer.domElement, controls: this.controls,
            onChange: () => { this.boundsDirty = true; this.requestRender(); },
            onCommit: changes => this.onTransform(changes), onError: key => this.onInvalidTransform(key),
            onPreview: changes => this.onTransformPreview(changes)
        });
        this.updateColors();
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.container);
        const canvas = this.renderer.domElement;
        canvas.tabIndex = 0;
        canvas.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
        canvas.addEventListener('keydown', event => {
            if (this.controls.enabled && Object.values(this.controls.keys).includes(event.code)) {
                cancelAnimationFrame(this.cameraFrame);
            }
        });
        this.controls.listenToKeyEvents(canvas);
        canvas.addEventListener('pointerdown', e => {
            e.preventDefault();
            canvas.focus({ preventScroll: true });
            getSelection()?.removeAllRanges();
            this.pointerId = e.pointerId;
            this.down = [e.clientX, e.clientY];
            this.orbitFromTop = navigationGesture(e.button, e.shiftKey, this.mode).leaveTop ? { button: e.button, shiftKey: e.shiftKey, clientX: e.clientX, clientY: e.clientY } : null;
        });
        canvas.addEventListener('pointermove', e => {
            if (!this.orbitFromTop || !e.buttons || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) <= 5) return;
            const gesture = this.orbitFromTop;
            this.orbitFromTop = null;
            this.setView('perspective', true);
            this.controls._onMouseDown(gesture);
        }, true);
        canvas.addEventListener('pointercancel', () => { this.down = null; this.orbitFromTop = null; });
        canvas.addEventListener('pointerup', e => {
            this.orbitFromTop = null;
            if (e.button !== 0 || !this.editing && e.shiftKey || !this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 5 || this.transform.active) return;
            const r = canvas.getBoundingClientRect();
            const pointer = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
            const ray = new THREE.Raycaster();
            ray.setFromCamera(pointer, this.camera);
            const hits = ray.intersectObjects([...this.objects.values()], true);
            for (const h of hits) {
                let o = h.object;
                while (o && !o.userData.exhibitId) o = o.parent;
                if (o) {
                    this.onSelect(o.userData.exhibitId, o.userData.instanceIndex ?? 0, e.shiftKey, this.editing);
                    return;
                }
            }
            this.onSelect(null, 0, e.shiftKey);
        });
        this.resize();
        return this;
    }
    resize() {
        if (!this.renderer) return;
        const w = this.container.clientWidth,
            h = this.container.clientHeight;
        if (!w || !h) return;
        if (this.width !== w || this.height !== h) {
            this.width = w;
            this.height = h;
            this.renderer.setSize(w, h);
        }
        if (this.camera.isPerspectiveCamera) this.camera.aspect = w / h;
        else {
            const span = this.orthoSpan || 25;
            this.camera.left = -span * w / h;
            this.camera.right = span * w / h;
            this.camera.top = span;
            this.camera.bottom = -span;
        }
        this.updateCameraViewport();
        this.camera.updateProjectionMatrix();
        this.updateCameraClipping();
        this.requestRender();
    }
    updateColors() {
        const { materials } = colorScheme();
        for (const [name, color] of Object.entries(materials)) this.materials[name].color.set(color);
        const axes = colorMode() === 'default' ? ['#ff0000', '#00ff00', '#0000ff', '#ffff00'] :
            [materials.problem, materials.ok, materials.selection, materials.editSelection];
        this.transform?.setColors(...axes);
        this.requestRender();
    }
    requestRender() {
        if (this.frame || !this.renderer) return;
        this.frame = requestAnimationFrame(async () => {
            this.frame = 0;
            try {
                if (this.boundsDirty || this.cameraLimitsDirty) this.updateCameraLimits();
                this.transform?.update();
                const offset = this.camera.position.clone().sub(this.controls.target);
                this.renderer.domElement.dataset.cameraOffset = coordinateVector(offset.toArray()).join(',');
                this.onCamera(this.navigationState());
                const building = this.root.children.find(object => object.userData.floor);
                if (this.mode === 'top' && building && this.topStyle !== 'shaded' && !this.topViewFailed && TopView.supported(this.renderer)) {
                    try {
                        this.topView ??= new TopView(this.renderer);
                        if (this.topView.render(this.renderer, this.scene, this.camera, building, this.topStyle)) {
                            this.renderer.domElement.dataset.map2d = this.topStyle;
                            return;
                        }
                    } catch (error) {
                        this.topViewFailed = true;
                        this.topView?.dispose();
                        this.topView = null;
                        console.warn('Could not render the 2D style; using the shaded map.', error);
                    }
                }
                this.renderer.domElement.dataset.map2d = 'shaded';
                await this.renderer.renderAsync(this.scene, this.camera);
            } catch (e) {
                this.onState('mapUnavailable');
            }
        });
    }
    async model(asset, material = this.materials.floor, templates = null, generation = this.generation) {
        if (generation !== this.generation) return null;
        if (!asset) return new THREE.Group();
        const template = templates?.get(asset.id);
        if (template) {
            const object = template.clone(true);
            object.traverse(mesh => { if (mesh.isMesh) mesh.material = material; });
            return object;
        }
        const result = await this.loader.loadAsync(asset.url);
        if (generation !== this.generation) {
            dispose(result.scene, this.sharedMaterials);
            return null;
        }
        try {
            const shareable = smoothNormals(result.scene);
            replaceMaterials(result.scene, material);
            // The first instance owns the template's geometry until this build is disposed.
            // Skinned meshes keep fresh skeletons by retaining the normal loading path.
            if (shareable) templates?.set(asset.id, result.scene);
            return result.scene;
        } catch (error) {
            dispose(result.scene, this.sharedMaterials);
            throw error;
        }
    }
    clearScene() {
        this.transform?.setSelection([]);
        this.topView?.clear();
        this.scene.remove(this.root);
        dispose(this.root, this.sharedMaterials);
        this.root = new THREE.Group();
        this.scene.add(this.root);
        this.boundsDirty = true;
        this.updateCameraLimits();
        this.objects.clear();
        this.floor = null;
        this.installedKey = null;
        this.requestRender();
    }
    async setData(data, floorId, selected, editing = false, {
        reset = false, selection = selected ? [selected] : [], hardwareSelection = []
    } = {}) {
        this.cancelTransform();
        this.data = data;
        this.selected = selected;
        this.selection = new Set(selection);
        this.hardwareSelection = hardwareSelection;
        this.editing = editing;
        const floor = data.floors.find(f => f.id === floorId);
        if (!floor) {
            this.generation++;
            this.clearScene();
            this.key = null;
            this.onState('mapReady');
            return;
        }
        const exhibits = data.exhibits.filter(e => e.floorId === floorId);
        const key = JSON.stringify([floor, data.assets, exhibits.map(e => [e.id, e.models.map(instance => instance.model)])]);
        if (key === this.installedKey) {
            // An undo may return to the installed layout while another layout is
            // still loading. Invalidate that load before reusing this scene.
            this.generation++;
            this.key = key;
            for (const exhibit of data.exhibits) {
                const object = this.objects.get(exhibit.id);
                if (!object) continue;
                object.userData.status = exhibit.status;
                applyTransform(object, exhibit.transform);
                exhibit.models.forEach((instance, index) => applyTransform(object.children[index], instance.transform));
            }
            this.boundsDirty = true;
            this.highlight(selected);
            if (reset) this.home();
            this.onState(this.partialModels ? 'mapPartial' : 'mapReady');
            return;
        }
        this.key = key;
        const generation = ++this.generation;
        if (this.floor && this.floor.id !== floorId) this.clearScene();
        this.onState('mapLoading');
        this.transform?.setSelection([]);
        const next = new THREE.Group();
        applyTransform(next, floor.transform);
        const objects = new Map();
        const templates = new Map();
        const assets = new Map();
        for (const asset of data.assets) if (!assets.has(asset.id)) assets.set(asset.id, asset);
        const failures = new Set();
        const loadModel = async (asset, material) => {
            if (asset && failures.has(asset.id)) return null;
            try { return await this.model(asset, material, templates, generation); }
            catch (error) {
                failures.add(asset?.id || 'floor');
                console.warn('Could not load model:', asset?.id, error);
                return null;
            }
        };
        try {
            const building = await loadModel(assets.get(floor.modelId), this.materials.floor);
            if (building) {
                building.userData.floor = true;
                next.add(building);
            }
            if (generation !== this.generation) {
                dispose(next, this.sharedMaterials);
                return;
            }
            for (const exhibit of exhibits) {
                if (!exhibit.models.length) continue;
                const group = new THREE.Group();
                group.userData.exhibitId = exhibit.id;
                group.userData.status = exhibit.status;
                applyTransform(group, exhibit.transform);
                next.add(group);
                for (const [index, instance] of exhibit.models.entries()) {
                    const holder = new THREE.Group();
                    holder.userData.exhibitId = exhibit.id;
                    holder.userData.instanceIndex = index;
                    applyTransform(holder, instance.transform);
                    group.add(holder);
                    const model = await loadModel(assets.get(instance.model), this.exhibitMaterial(exhibit.status));
                    if (model) holder.add(model);
                    if (generation !== this.generation) {
                        dispose(next, this.sharedMaterials);
                        return;
                    }
                }
                objects.set(exhibit.id, group);
            }
            if (generation !== this.generation) {
                dispose(next, this.sharedMaterials);
                return;
            }
            this.topView?.clear();
            this.scene.remove(this.root);
            dispose(this.root, this.sharedMaterials);
            this.root = next;
            this.scene.add(next);
            this.boundsDirty = true;
            this.updateCameraLimits();
            this.objects = objects;
            this.floor = floor;
            this.installedKey = key;
            for (const exhibit of this.data.exhibits) {
                const object = objects.get(exhibit.id);
                if (object) object.userData.status = exhibit.status;
            }
            this.highlight(this.selected);
            this.partialModels = failures.size > 0;
            if (reset) this.home();
            this.requestRender();
            this.onState(this.partialModels ? 'mapPartial' : 'mapReady');
        } catch (e) {
            dispose(next, this.sharedMaterials);
            if (generation === this.generation) {
                this.clearScene();
                this.key = null;
                this.onState('mapUnavailable');
            }
        }
    }
    exhibitMaterial(status, selected = false) {
        if (selected) return this.materials.selection;
        return this.editing ? this.materials.retired : this.materials[status] || this.materials.ok;
    }
    transformEntries() {
        if (!this.editing) return [];
        if (this.hardwareSelection.length) return this.hardwareSelection.flatMap(entry => {
            const object = this.objects.get(entry.exhibitId)?.children[entry.instanceIndex];
            return object ? [{ ...entry, object }] : [];
        });
        return [...this.selection].flatMap(exhibitId => {
            const object = this.objects.get(exhibitId);
            return object ? [{ exhibitId, object }] : [];
        });
    }
    highlight(id) {
        this.selected = id;
        const hardware = new Set(this.hardwareSelection.map(transformKey));
        for (const [exhibitId, group] of this.objects) {
            for (const [instanceIndex, holder] of group.children.entries()) {
                const material = hardware.has(transformKey({ exhibitId, instanceIndex })) ? this.materials.editSelection :
                    this.exhibitMaterial(group.userData.status, !this.hardwareSelection.length && this.selection.has(exhibitId));
                holder.traverse(mesh => { if (mesh.isMesh) mesh.material = material; });
            }
        }
        this.transform?.setSelection(this.transformEntries());
        this.requestRender();
    }
    cancelTransform() {
        const cancelled = this.transform?.cancel?.() || false;
        this.down = null; this.orbitFromTop = null;
        return cancelled;
    }
    beginTransform(mode) { cancelAnimationFrame(this.cameraFrame); return this.transform?.begin(mode) || false; }
    transformKey(event) { return this.transform?.key(event) || false; }
    beginSelectionField() {
        this.cancelTransform();
        if (this.key !== this.installedKey) throw Error('mapLoading');
        const entries = this.transformEntries();
        if (entries.length < 2) throw Error('mapUnavailable');
        return { transaction: new TransformTransaction(entries), orientation: this.transform.orientation() };
    }
    previewSelectionField(preview, key, axis, value) {
        const changes = preview.transaction.apply(selectionFieldDelta(preview.transaction.center, key, axis, value, preview.orientation));
        this.boundsDirty = true;
        this.transform?.update(); this.requestRender();
        this.onTransformPreview(changes);
        return changes;
    }
    restoreSelectionField(preview) {
        preview.transaction.restore();
        this.boundsDirty = true;
        this.transform?.update(); this.requestRender();
        this.onTransformPreview(preview.transaction.changes());
    }
    previewTransforms(changes) {
        for (const { exhibitId, instanceIndex, transform } of changes) {
            const group = this.objects.get(exhibitId);
            const object = instanceIndex == null ? group : group?.children[instanceIndex];
            if (object) { applyTransform(object, transform); object.updateMatrixWorld(true); }
        }
        this.boundsDirty = true; this.transform?.update(); this.requestRender();
    }
    placementPosition(transform) {
        if (!this.controls) return [0, 0, 0];
        const group = new THREE.Object3D();
        applyTransform(group, transform);
        group.updateMatrix();
        this.root.updateMatrixWorld(true);
        const matrix = new THREE.Matrix4().multiplyMatrices(this.root.matrixWorld, group.matrix).invert();
        const position = this.controls.target.clone().applyMatrix4(matrix);
        return [position.x, 0, position.z];
    }
    setTool(tool, snap = false, space = 'world', axis = '') {
        this.tool = tool; this.snap = snap;
        this.transform?.configure(tool, snap, space, axis);
    }
    sceneBounds() {
        if (this.boundsDirty || !this.bounds) {
            this.root.updateMatrixWorld(true);
            this.bounds = new THREE.Box3().setFromObject(this.root);
            this.boundsDirty = false;
            this.cameraLimitsDirty = true;
        }
        return this.bounds;
    }
    updateCameraClipping(camera = this.camera, box = null, targetDistance = null) {
        const dirty = !box && this.boundsDirty;
        box ??= this.sceneBounds();
        if ((dirty || this.cameraLimitsDirty) && camera === this.camera && this.controls) {
            const distance = camera.position.distanceTo(this.controls.target);
            Object.assign(this.controls, controlLimits(box, distance));
            this.cameraLimitsDirty = false;
        }
        targetDistance ??= camera === this.camera && this.controls ? camera.position.distanceTo(this.controls.target) : Infinity;
        const { near, far } = clippingPlanes(box, camera, targetDistance);
        if (camera.near !== near || camera.far !== far) {
            camera.near = near;
            camera.far = far;
            camera.updateProjectionMatrix();
        }
    }
    updateCameraLimits(distance = this.camera.position.distanceTo(this.controls?.target || new THREE.Vector3())) {
        const box = this.sceneBounds();
        if (this.controls) Object.assign(this.controls, controlLimits(box, this.camera.position.distanceTo(this.controls.target), distance));
        this.cameraLimitsDirty = false;
        this.updateCameraClipping(this.camera, box);
    }
    framingDirection(mode = this.mode) {
        return new THREE.Vector3(...(mode === 'top' ? orbitOffset(1, 0, 90) : cameraOffset(mode, 1))).normalize();
    }
    framingAspect() {
        const width = this.container.clientWidth || this.width || 1;
        const height = this.container.clientHeight || this.height || 1;
        return width / height;
    }
    framingPadding() {
        const bounds = this.viewportBounds();
        return { horizontal: Math.min(.94, (bounds.right - bounds.left) / 2), vertical: Math.min(.94, (bounds.top - bounds.bottom) / 2) };
    }
    controlAngles(...positions) {
        const angles = positions.map(position => new THREE.Spherical().setFromVector3(position.clone().sub(this.controls.target)).phi);
        this.controls.minPolarAngle = Math.min(.000001, ...angles);
        this.controls.maxPolarAngle = Math.max(this.mode === 'top' ? .000001 : Math.PI / 2, ...angles);
    }
    frameTarget(center, distance, span, animate = true, position = null, { orbit = false } = {}) {
        cancelAnimationFrame(this.cameraFrame);
        const offset = this.framingDirection().multiplyScalar(distance);
        const startTarget = this.controls.target.clone();
        const startPosition = this.camera.position.clone();
        const endPosition = position || center.clone().add(offset);
        const startSpan = this.orthoSpan || span;
        const startZoom = this.camera.zoom;
        const startOrbit = new THREE.Spherical().setFromVector3(startPosition.clone().sub(startTarget));
        const endOrbit = new THREE.Spherical().setFromVector3(endPosition.clone().sub(center));
        const headingDelta = Math.atan2(Math.sin(endOrbit.theta - startOrbit.theta), Math.cos(endOrbit.theta - startOrbit.theta));
        const started = performance.now();
        const step = () => {
            const p = !animate || matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : Math.min(1, (performance.now() - started) / (orbit ? 320 : 220));
            const ease = 1 - Math.pow(1 - p, 3);
            this.controls.target.copy(startTarget).lerp(center, ease);
            if (orbit) {
                const radius = Math.exp(Math.log(Math.max(startOrbit.radius, 1e-12)) * (1 - ease) + Math.log(Math.max(endOrbit.radius, 1e-12)) * ease);
                this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(
                    radius, startOrbit.phi + (endOrbit.phi - startOrbit.phi) * ease, startOrbit.theta + headingDelta * ease)));
                this.orthoSpan = Math.exp(Math.log(startSpan) * (1 - ease) + Math.log(span) * ease);
            } else {
                this.camera.position.copy(startPosition).lerp(endPosition, ease);
                this.orthoSpan = startSpan + (span - startSpan) * ease;
            }
            this.camera.zoom = startZoom + (1 - startZoom) * ease;
            this.controlAngles(this.camera.position);
            this.updateCameraLimits(distance);
            this.resize();
            this.controls.update();
            // OrbitControls makes exact poles safe by tilting them 1e-6 radians.
            // Keep the coordinates of an explicitly requested saved view exact.
            if (position && p === 1) {
                this.camera.position.copy(position);
                aimCamera(this.camera, center);
                this.updateCameraClipping();
            }
            if (p < 1) this.cameraFrame = requestAnimationFrame(step);
        };
        step();
    }
    home() {
        const preset = this.floor?.views?.[viewKey(this.mode)];
        if (preset) {
            this.applyView(preset);
            return;
        }
        this.fit();
    }
    fit() {
        const box = this.sceneBounds();
        const size = box.getSize(new THREE.Vector3());
        const scale = Math.min(1, boundsScale(box) / 10);
        const span = Math.max(size.x, size.z, 10 * scale);
        const view = frameBounds(box, this.framingDirection(), this.framingAspect(), {
            distance: span * 1.6, span: span * .65, perspective: this.mode !== 'top', ...this.framingPadding()
        });
        this.frameTarget(new THREE.Vector3(...view.target), new THREE.Vector3(...view.target).distanceTo(new THREE.Vector3(...view.position)), view.span);
    }
    captureView(mode = this.mode) {
        mode = cameraMode(mode);
        const target = this.controls.target.toArray();
        const distance = this.camera.position.distanceTo(this.controls.target);
        const top = mode === 'top';
        const offset = orbitOffset(distance, this.navigationState().heading, top ? 90 : 35);
        return {
            position: coordinateVector((top && this.mode !== 'top') || (!top && this.mode === 'top') ? target.map((value, index) => value + offset[index]) : this.camera.position.toArray()),
            target: coordinateVector(target),
            span: coordinateNumber(this.camera.isOrthographicCamera ? this.orthoSpan / this.camera.zoom : Math.max(3 * Math.min(1, boundsScale(this.sceneBounds()) / 10), distance * .36))
        };
    }
    fallbackView(ids, mode = this.mode) {
        return this.automaticView(ids.map(id => this.objects.get(id)).filter(Boolean), mode);
    }
    automaticView(objects, mode = this.mode) {
        mode = cameraMode(mode);
        this.root.updateMatrixWorld(true);
        const geometry = focusGeometry(objects);
        if (!geometry.points.length) {
            geometry.box.copy(this.sceneBounds());
            geometry.points = boundsCorners(geometry.box);
        }
        const padding = this.framingPadding();
        const options = { aspect: this.framingAspect(), direction: this.camera.position.clone().sub(this.controls.target),
            padding: { horizontal: padding.horizontal * .82, vertical: padding.vertical * .82 }, occluders: this.root.children };
        return (mode === 'top' ? birdFocusView : nextBestView)(geometry, options) ||
            frameBounds(geometry.box, this.framingDirection(mode), options.aspect, { perspective: mode !== 'top', ...padding });
    }
    applyView(preset, mode = this.mode, options = {}) {
        if (!preset) return;
        mode = cameraMode(mode);
        if (this.mode !== mode) {
            this.setView(mode, true);
        }
        const center = new THREE.Vector3(...preset.target);
        const position = new THREE.Vector3(...preset.position);
        this.frameTarget(center, center.distanceTo(position), preset.span, true, position, options);
    }
    viewportBounds() {
        const rect = this.renderer?.domElement.getBoundingClientRect() || { width: 0, height: 0 };
        const panel = this.container.closest?.('#map-panel');
        const workspace = panel?.closest('#workspace');
        const overlays = workspace ? [...workspace.querySelectorAll('#sidebar, #inspector, #map-heading, #map-controls, #transform-toolbar')]
            .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && getComputedStyle(element).visibility !== 'hidden')
            .map(element => {
                // Panel springs animate transforms. Frame against their settled
                // layout, including when Focus is clicked during panel entry.
                let left = -(window.scrollX || 0), top = -(window.scrollY || 0);
                for (let node = element; node; node = node.offsetParent) { left += node.offsetLeft; top += node.offsetTop; }
                const width = element.offsetWidth, height = element.offsetHeight;
                return { left, top, right: left + width, bottom: top + height, width, height };
            }) : [];
        return clearViewport(rect, overlays);
    }
    updateCameraViewport(camera = this.camera) {
        const bounds = this.viewportBounds();
        const width = this.container.clientWidth || this.width, height = this.container.clientHeight || this.height;
        if (!width || !height) return;
        const x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
        if (Math.abs(x) + Math.abs(y) < 1e-10) camera.clearViewOffset();
        else camera.setViewOffset(width, height, -x * width / 2, y * height / 2, width, height);
    }
    isVisible(id, camera = this.camera, targetDistance = null) {
        const object = this.objects.get(id);
        if (!object) return false;
        this.updateCameraViewport(camera);
        this.updateCameraClipping(camera, null, targetDistance);
        camera.updateMatrixWorld();
        const bounds = this.viewportBounds();
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3()).project(camera);
        if (center.z < -1 || center.z > 1) return false;
        for (const point of boundsCorners(box)) {
            point.project(camera);
            if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.bottom || point.y > bounds.top || point.z > 1 || point.z < -1) return false;
        }
        return true;
    }
    focusView(id, preset, mode = this.mode) {
        const object = this.objects.get(id);
        if (!object) return preset;
        const aspect = this.framingAspect();
        const perspective = cameraMode(mode) === 'perspective';
        const camera = perspective ? new THREE.PerspectiveCamera(38, aspect, .05, 2000) :
            new THREE.OrthographicCamera(-preset.span * aspect, preset.span * aspect, preset.span, -preset.span, .05, 2000);
        const target = new THREE.Vector3(...preset.target);
        camera.position.fromArray(preset.position);
        aimCamera(camera, target);
        camera.updateMatrixWorld();
        if (this.isVisible(id, camera, camera.position.distanceTo(target))) return preset;
        const box = new THREE.Box3().setFromObject(object);
        const bounds = this.viewportBounds();
        const direction = camera.position.clone().sub(target);
        if (!direction.lengthSq()) direction.copy(this.framingDirection(mode));
        return frameBounds(box, direction, aspect, {
            distance: camera.position.distanceTo(target), span: preset.span, perspective,
            horizontal: (bounds.right - bounds.left) / 2, vertical: (bounds.top - bounds.bottom) / 2
        });
    }
    focusObjects() {
        if (this.editing) return this.transformEntries().map(entry => entry.object);
        const object = this.objects.get(this.selected);
        return object ? [object] : [];
    }
    focus(onlyWhenHidden = false) {
        const objects = this.focusObjects();
        if (!objects.length || (onlyWhenHidden && objects.length === 1 && this.isVisible(this.selected))) return;
        this.cancelTransform();
        const exhibit = this.data?.exhibits.find(record => this.objects.get(record.id) === objects[0]);
        const preset = objects.length === 1 ? exhibit?.views?.[viewKey(this.mode)] : null;
        if (preset) this.applyView(this.focusView(exhibit.id, preset));
        else this.applyView(this.automaticView(objects), this.mode, { orbit: true });
    }
    focusFloor() {
        const ids = this.data.exhibits.filter(exhibit => exhibit.floorId === this.floor.id).map(exhibit => exhibit.id);
        const key = viewKey(this.mode);
        this.applyView(this.floor.views?.[key] || this.fallbackView(ids));
    }
    setView(mode, preserve = false) {
        this.cancelTransform();
        mode = cameraMode(mode);
        cancelAnimationFrame(this.cameraFrame);
        const state = this.navigationState();
        const target = this.controls.target.clone();
        const distance = this.camera.position.distanceTo(target);
        this.mode = mode;
        const old = this.camera;
        this.camera = mode === 'perspective' ? new THREE.PerspectiveCamera(38, 1, .05, 2000) : new THREE.OrthographicCamera(-20, 20, 20, -20, .05, 2000);
        const halfFov = Math.tan(THREE.MathUtils.degToRad(19));
        this.orthoSpan = old.isOrthographicCamera ? this.orthoSpan / old.zoom : distance * halfFov / old.zoom;
        const nextDistance = mode === 'perspective' && old.isOrthographicCamera ? this.orthoSpan / halfFov : distance;
        const offset = new THREE.Vector3(...orbitOffset(nextDistance, state.heading,
            mode === 'top' ? 90 : preserve ? state.elevation : state.mode === 'top' ? 35 : state.elevation));
        this.camera.position.copy(target).add(offset);
        this.controls.object = this.camera;
        this.controls.enableRotate = true;
        this.controls.minPolarAngle = .000001;
        this.controls.maxPolarAngle = mode === 'top' ? .000001 : Math.PI / 2;
        this.renderer.domElement.dataset.view = mode;
        this.renderer.domElement.dataset.projection = this.camera.isOrthographicCamera ? 'orthographic' : 'perspective';
        if (this.transform) this.transform.camera = this.camera;
        this.updateCameraLimits(nextDistance);
        this.resize();
        this.controls.update();
        this.onMode(mode);
    }
    navigationState() {
        return { ...orbitState(this.camera.position.toArray(), this.controls?.target.toArray() || [0, 0, 0]), mode: this.mode };
    }
    setHeading(heading) {
        if (!Number.isFinite(heading)) return;
        cancelAnimationFrame(this.cameraFrame);
        const state = this.navigationState();
        const offset = this.camera.position.clone().sub(this.controls.target)
            .applyAxisAngle(new THREE.Vector3(0, 1, 0), -(heading - state.heading) * Math.PI / 180);
        this.camera.position.copy(this.controls.target).add(offset);
        this.controlAngles(this.camera.position);
        this.controls.update();
        this.requestRender();
    }
    setElevation(elevation) {
        if (!Number.isFinite(elevation)) return;
        cancelAnimationFrame(this.cameraFrame);
        const state = this.navigationState();
        elevation = Math.max(0, Math.min(90, elevation));
        if (this.mode === 'top' && elevation < 90) this.setView('perspective', true);
        const distance = this.camera.position.distanceTo(this.controls.target);
        this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...orbitOffset(distance, state.heading, elevation)));
        this.controls.update();
        this.requestRender();
    }
    command(action) {
        if (action === 'home') return this.home();
        if (action === 'fit') return this.fit();
        if (action === 'focus') return this.focus();
        if (['top', 'perspective'].includes(action)) return this.setView(action);
        if (action === 'north') return this.setHeading(0);
        if (action === 'turnLeft' || action === 'turnRight') {
            return this.setHeading(this.navigationState().heading + (action === 'turnLeft' ? 15 : -15));
        }
        cancelAnimationFrame(this.cameraFrame);
        if (action === 'zoomIn' || action === 'zoomOut') {
            const factor = action === 'zoomIn' ? .8 : 1.25;
            if (this.camera.isOrthographicCamera) {
                this.camera.zoom = Math.min(15, Math.max(.1, this.camera.zoom / factor));
                this.camera.updateProjectionMatrix();
            } else {
                const v = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
                v.clampLength(this.controls.minDistance, this.controls.maxDistance);
                this.camera.position.copy(this.controls.target).add(v);
            }
        }
        this.controls.update();
        this.requestRender();
    }
    destroy() {
        this.stopColorUpdates();
        this.generation++;
        cancelAnimationFrame(this.frame);
        cancelAnimationFrame(this.cameraFrame);
        this.observer?.disconnect();
        this.controls?.dispose();
        this.transform?.dispose();
        dispose(this.scene, this.sharedMaterials);
        disposeMaterials(this.sharedMaterials);
        this.topView?.dispose();
        this.renderer?.dispose();
        this.renderer?.domElement.remove();
    }
}
