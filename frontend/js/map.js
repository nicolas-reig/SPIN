import * as THREE from 'three';
import {
    GLTFLoader
} from 'three/addons/loaders/GLTFLoader.js';
import { MapOrbitControls } from './map-orbit-controls.js';
import { TransformController } from './transform-controller.js';
import { applyTransform, applyGroundedTransforms, belowGround, transformKey, geometryCenter, exhibitPlacement, ExhibitPlacementTransaction, TransformTransaction, selectionFieldDelta } from './transform-math.js';
import { coordinateNumber, coordinateVector, focusPlacement } from './domain.js';

import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { cameraMode, cameraOffset, navigationGesture, orbitState, orbitOffset, viewKey } from './camera.js';
import { colorMode, colorScheme, onColorModeChange } from './colors.js';
import { TopView } from './top-view.js';
import { dispose, disposeMaterials, replaceMaterials } from './model-resources.js';
import { boundsScale, boundsCorners, aimCamera, limitCameraHeight, frameBounds, controlLimits, clippingPlanes, clearViewport } from './camera-framing.js';
import { focusGeometry, nextBestView, birdFocusView } from './camera-focus.js';
import { MapOverlays } from './map-overlays.js';

const perspectiveFocusPadding = .72;

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
        overlayPreferences = {},
        onSelect = () => {},
        onTransform = () => {},
        onInvalidTransform = () => {},
        onTransformPreview = () => {},
        onState = () => {},
        onMode = () => {},
        onCamera = () => {}
    } = {}) {
        this.container = container;
        this.overlayPreferences = overlayPreferences;
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
        this.focusDirections = new Map();
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
        this.exhibitRay = new THREE.Raycaster();
        this.pointerPosition = new THREE.Vector2();
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
        if (this.overlayPreferences.topCircle || this.overlayPreferences.groupLabels) {
            this.overlays = new MapOverlays(this.container, (id, extend) => this.onSelect(id, 0, extend, false));
        }
        this.controls = new MapOrbitControls(this.camera, this.renderer.domElement);
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
        this.bindPointerEvents(canvas);
        this.resize();
        return this;
    }
    bindPointerEvents(canvas) {
        this.pointerEvents = new AbortController();
        const listen = (target, type, handler, capture = false) =>
            target.addEventListener(type, handler, { capture, signal: this.pointerEvents.signal });
        const movedPointer = (event, start) => Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 5;

        const clearHover = () => {
            this.hoverPointer = null;
            delete canvas.dataset.exhibitHover;
        };
        const queueHover = event => {
            if (event.pointerType === 'touch') return;
            this.hoverPointer = event;
            if (this.hoverFrame) return;
            this.hoverFrame = requestAnimationFrame(() => {
                this.hoverFrame = 0;
                const pointer = this.hoverPointer;
                this.hoverPointer = null;
                if (pointer && !canvas.dataset.cameraDragging && !this.transform.active &&
                    this.pickExhibit(pointer)) canvas.dataset.exhibitHover = 'true';
                else delete canvas.dataset.exhibitHover;
            });
        };
        listen(canvas, 'pointerdown', e => {
            e.preventDefault();
            canvas.focus({ preventScroll: true });
            getSelection()?.removeAllRanges();
            const supportedButton = e.button >= 0 && e.button <= 2;
            this.down = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, supportedButton,
                orbitFromTop: supportedButton && navigationGesture(e.button, e.shiftKey, this.mode).leaveTop ? e : null };
        });
        listen(canvas, 'pointerenter', queueHover);
        listen(canvas, 'pointerleave', clearHover);
        listen(canvas, 'pointermove', e => {
            const down = this.down;
            if (down?.id === e.pointerId && e.buttons && (down.dragged || movedPointer(e, down))) {
                down.dragged = true;
                if (down.orbitFromTop) {
                    const gesture = down.orbitFromTop;
                    down.orbitFromTop = null;
                    this.setView('perspective', true);
                    this.down = down;
                    this.controls._onMouseDown(gesture);
                }
                if (e.pointerType !== 'touch' && this.controls.enabled && down.supportedButton) {
                    clearHover();
                    canvas.dataset.cameraDragging = 'true';
                }
            } else if (!e.buttons) {
                if (down?.id === e.pointerId) this.resetPointerDrag();
                queueHover(e);
            }
        }, true);
        listen(canvas, 'pointerup', e => {
            const down = this.down;
            if (down?.id !== e.pointerId) return;
            this.resetPointerDrag();
            if (e.button === 0 && !down.dragged && !movedPointer(e, down) && !this.transform.active) {
                const exhibit = this.pickExhibit(e);
                if (exhibit) this.onSelect(exhibit.exhibitId, exhibit.instanceIndex ?? 0, e.shiftKey, this.editing);
                else this.onSelect(null, 0, e.shiftKey);
            }
            queueHover(e);
        });
        listen(canvas, 'pointercancel', event => {
            if (this.down?.id === event.pointerId) this.resetPointerDrag();
            clearHover();
        });
        listen(canvas, 'lostpointercapture', event => {
            if (this.down?.id === event.pointerId) this.resetPointerDrag();
            if (!event.buttons) queueHover(event);
        });
        listen(canvas, 'wheel', queueHover);
        listen(window, 'blur', () => { this.resetPointerDrag(); clearHover(); });
    }
    resetPointerDrag() {
        this.down = null;
        if (this.renderer) delete this.renderer.domElement.dataset.cameraDragging;
    }
    pickExhibit(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
        const circle = this.mode === 'top' && !this.editing ? this.overlays?.pick(x * rect.width, y * rect.height) : null;
        if (circle) return { exhibitId: circle };
        this.camera.updateMatrixWorld();
        this.exhibitRay.setFromCamera(this.pointerPosition.set(x * 2 - 1, 1 - y * 2), this.camera);
        for (const hit of this.exhibitRay.intersectObjects([...this.objects.values()], true)) {
            let object = hit.object;
            while (object && !object.userData.exhibitId) object = object.parent;
            if (object) return object.userData;
        }
        return null;
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
                if (this.overlays) this.overlays.render({
                    camera: this.camera, width: this.width, height: this.height, viewport: this.cameraViewport,
                    exhibits: this.data?.exhibits || [], objects: this.objects, selection: this.selection,
                    circles: Boolean(this.overlayPreferences.topCircle && this.mode === 'top' && !this.editing),
                    labels: this.overlayPreferences.groupLabels
                });
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
        reset = false, selection = selected ? [selected] : [], hardwareSelection = [], savedExhibits = data.exhibits
    } = {}) {
        this.cancelTransform();
        if (this.data?.assets !== data.assets) this.assetRevisions = new Map(data.assets.map(asset => [asset.id, asset.revision]));
        this.data = data;
        this.savedExhibits = savedExhibits;
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
                group.userData.exhibitPlacement = true;
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
                    if (model) {
                        holder.userData.placementCenter = geometryCenter(model).toArray();
                        holder.add(model);
                    }
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
                const chosen = this.hardwareSelection.length ? hardware.has(transformKey({ exhibitId, instanceIndex })) : this.selection.has(exhibitId);
                const material = this.editing ? chosen ? this.materials.editSelection : this.selection.has(exhibitId) ? this.materials.editContext : this.materials.retired :
                    this.exhibitMaterial(group.userData.status, chosen);
                holder.traverse(mesh => { if (mesh.isMesh) mesh.material = material; });
            }
        }
        this.transform?.setSelection(this.transformEntries());
        this.requestRender();
    }
    cancelTransform() {
        const cancelled = this.transform?.cancel?.() || false;
        this.resetPointerDrag();
        return cancelled;
    }
    beginTransform(mode) {
        cancelAnimationFrame(this.cameraFrame);
        this.resetPointerDrag();
        return this.transform?.begin(mode, {}, { wrapCursor: true }) || false;
    }
    transformKey(event) { return this.transform?.key(event) || false; }
    exhibitPlacement(id) {
        const group = this.objects.get(id);
        return group?.children.length && this.key === this.installedKey ? exhibitPlacement(group) : null;
    }
    beginExhibitPlacement(id) {
        this.cancelTransform();
        if (this.key !== this.installedKey) throw Error('mapLoading');
        const group = this.objects.get(id);
        if (!group?.children.length) throw Error('mapUnavailable');
        const transaction = new ExhibitPlacementTransaction(id, group, { grounded: true });
        return { transaction, placement: transaction.placement };
    }
    previewExhibitPlacement(preview, key, axis, value) {
        const changes = preview.transaction.field(key, axis, value);
        this.boundsDirty = true;
        this.transform?.update(); this.requestRender();
        this.onTransformPreview(changes);
        return changes;
    }
    beginSelectionField() {
        this.cancelTransform();
        if (this.key !== this.installedKey) throw Error('mapLoading');
        const entries = this.transformEntries();
        if (entries.length < 2) throw Error('mapUnavailable');
        return { transaction: new TransformTransaction(entries, { grounded: true }), orientation: this.transform.orientation() };
    }
    previewSelectionField(preview, key, axis, value) {
        const delta = selectionFieldDelta(preview.transaction.center, key, axis, value, preview.orientation);
        const rotation = key === 'rotation' ? new THREE.Quaternion().setFromRotationMatrix(delta) : new THREE.Quaternion();
        const changes = preview.transaction.apply(delta, rotation);
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
    previewTransforms(changes, { grounded = false, cache } = {}) {
        const entries = changes.map(({ exhibitId, instanceIndex }) => {
            const group = this.objects.get(exhibitId);
            const object = instanceIndex == null ? group : group?.children[instanceIndex];
            return { exhibitId, instanceIndex, object };
        });
        if (grounded) {
            if (this.key !== this.installedKey) throw Error('mapLoading');
            if (entries.some(({ object }) => !object?.children.length)) throw Error('mapPartial');
            changes = applyGroundedTransforms(entries, changes.map(change => change.transform), cache);
        } else {
            entries.forEach(({ object }, index) => {
                if (object) { applyTransform(object, changes[index].transform); object.updateMatrixWorld(true); }
            });
        }
        this.boundsDirty = true; this.transform?.update(); this.requestRender();
        return changes;
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
    setTool(tool, snap = false, space = 'local', axis = '') {
        this.tool = tool; this.snap = snap;
        this.transform?.configure(tool, snap, space, axis);
    }
    sceneBounds() {
        if (this.boundsDirty || !this.bounds) {
            this.root.updateMatrixWorld(true);
            this.bounds = new THREE.Box3().setFromObject(this.root);
            this.overlays?.invalidate();
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
        const endPosition = position?.clone() || center.clone().add(offset);
        if (limitCameraHeight(endPosition, center, this.mode === 'top')) distance = center.distanceTo(endPosition);
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
            limitCameraHeight(this.camera.position, this.controls.target);
            this.controlAngles(this.camera.position);
            this.updateCameraLimits(distance);
            this.resize();
            this.controls.update();
            // OrbitControls makes exact poles safe by tilting them 1e-6 radians.
            // Keep the coordinates of an explicitly requested saved view exact.
            if (position && p === 1) {
                this.camera.position.copy(endPosition);
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
        const target = this.controls.target;
        const distance = this.camera.position.distanceTo(target);
        const top = mode === 'top';
        const position = mode === this.mode ? this.camera.position.clone() :
            target.clone().add(new THREE.Vector3(...orbitOffset(distance, this.navigationState().heading, top ? 90 : 35)));
        limitCameraHeight(position, target, top);
        return {
            position: coordinateVector(position.toArray()),
            target: coordinateVector(target.toArray()),
            span: coordinateNumber(this.camera.isOrthographicCamera ? this.orthoSpan / this.camera.zoom : Math.max(3 * Math.min(1, boundsScale(this.sceneBounds()) / 10), distance * .36))
        };
    }
    fallbackView(ids, mode = this.mode) {
        const exhibit = ids.length === 1 ? this.data?.exhibits.find(record => record.id === ids[0]) : null;
        return this.automaticView(ids.map(id => this.objects.get(id)).filter(Boolean), mode, exhibit);
    }
    focusDirection(record, object, preparingSave = false) {
        const placement = focusPlacement(record);
        const saved = this.savedExhibits.find(exhibit => exhibit.id === record.id);
        const savedPlacement = focusPlacement(saved);
        if (saved?.focusDirection && savedPlacement === placement) return saved.focusDirection;
        const models = [this.floor.modelId, ...record.models.map(instance => instance.model)];
        const key = JSON.stringify([this.data.datasetKey, placement, models.map(id => this.assetRevisions.get(id))]);
        const cached = this.focusDirections.get(record.id);
        if (cached?.key === key) return cached.direction;
        // In edit mode a draft can change many times before the signed save.
        if (!preparingSave && this.editing && placement !== savedPlacement) {
            return saved?.focusDirection || (cached?.placement === savedPlacement ? cached.direction : null);
        }

        this.root.updateMatrixWorld(true);
        const view = nextBestView(focusGeometry([object]), {
            direction: this.framingDirection('perspective'), occluders: this.root.children,
            padding: { horizontal: perspectiveFocusPadding, vertical: perspectiveFocusPadding }
        });
        if (!view) return null;
        const direction = coordinateVector(new THREE.Vector3(...view.position).sub(new THREE.Vector3(...view.target)).normalize().toArray());
        this.focusDirections.set(record.id, { key, placement, direction });
        return direction;
    }
    static async groundPlacement(data, record, instanceIndex) {
        const floor = data.floors.find(floor => floor.id === record.floorId);
        if (!floor) throw Error('invalidFloor');
        const exhibit = instanceIndex == null ? record : { ...record, models: [record.models[instanceIndex]] };
        const view = new MapView({});
        try {
            await view.setData({ ...data, floors: [{ ...floor, modelId: null }], exhibits: [exhibit] }, floor.id, null);
            const group = view.objects.get(record.id);
            if (!group || group.children.some(holder => !holder.children.length)) throw Error('mapPartial');
            const object = instanceIndex == null ? group : group.children[0];
            const placement = instanceIndex == null ? record : record.models[instanceIndex];
            const [change] = applyGroundedTransforms([{ exhibitId: record.id, instanceIndex, object }], [placement.transform]);
            placement.transform = change.transform;
        } finally {
            view.destroy();
        }
    }
    static async prepareFocusDirections(data, savedExhibits, records, displayed, signal) {
        const result = new Map();
        const originals = new Map(savedExhibits.map(record => [record.id, record]));
        for (const floorId of new Set(records.map(record => record.floorId))) {
            signal?.throwIfAborted();
            const current = displayed?.data === data && displayed.floor?.id === floorId && displayed.key === displayed.installedKey;
            const view = current ? displayed : new MapView({});
            const abort = () => { view.generation++; };
            if (!current) signal?.addEventListener('abort', abort, { once: true });
            try {
                if (!current) await view.setData(data, floorId, null, false, { savedExhibits });
                signal?.throwIfAborted();
                for (const record of records.filter(item => item.floorId === floorId)) {
                    const object = view.objects.get(record.id);
                    const original = originals.get(record.id);
                    const unchanged = original?.floorId === floorId && JSON.stringify(original.transform) === JSON.stringify(record.transform) ?
                        new Set(original.models.map(model => JSON.stringify(model))) : new Set();
                    if (object?.children.some((holder, index) => holder.children.length &&
                        !unchanged.has(JSON.stringify(record.models[index])) && belowGround(holder))) throw Error('placementBelowGround');
                    if (!object || object.children.some(holder => !holder.children.length) ||
                        view.floor.modelId && !view.root.children.some(child => child.userData.floor)) continue;
                    try {
                        const direction = view.focusDirection(record, object, true);
                        if (direction) result.set(record.id, direction);
                    } catch (error) {
                        console.warn('Could not prepare automatic exhibit focus.', error);
                    }
                }
            } finally {
                if (!current) {
                    signal?.removeEventListener('abort', abort);
                    view.destroy();
                }
            }
        }
        return Object.fromEntries(result);
    }
    automaticView(objects, mode = this.mode, exhibit = null) {
        mode = cameraMode(mode);
        const padding = this.framingPadding(), aspect = this.framingAspect();
        const factor = mode === 'top' ? .82 : perspectiveFocusPadding;
        const focusPadding = { horizontal: padding.horizontal * factor, vertical: padding.vertical * factor };
        if (mode === 'perspective' && exhibit && objects.length === 1 && this.floor && this.key === this.installedKey) {
            const box = new THREE.Box3().setFromObject(objects[0]);
            const cached = box.isEmpty() ? null : this.focusDirection(exhibit, objects[0]);
            const direction = cached ? new THREE.Vector3(...cached) : this.framingDirection(mode);
            return frameBounds(box.isEmpty() ? this.sceneBounds() : box, direction, aspect, focusPadding);
        }
        this.root.updateMatrixWorld(true);
        const geometry = focusGeometry(objects);
        if (!geometry.points.length) {
            geometry.box.copy(this.sceneBounds());
            geometry.points = boundsCorners(geometry.box);
        }
        const options = { aspect, direction: this.camera.position.clone().sub(this.controls.target),
            padding: focusPadding, occluders: this.root.children };
        const view = (mode === 'top' ? birdFocusView : nextBestView)(geometry, options);
        return view?.position[1] >= 0 ? view : frameBounds(geometry.box, this.framingDirection(mode), options.aspect,
            { perspective: mode !== 'top', ...padding });
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
        const overlays = workspace ? [...workspace.querySelectorAll('#sidebar, #inspector, #inspector-stack, #map-heading, #map-controls, #transform-toolbar')]
            .filter(element => !element.hidden && (element.id === 'inspector-stack' || element.getAttribute('aria-hidden') !== 'true') && getComputedStyle(element).visibility !== 'hidden')
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
        if (camera === this.camera) this.cameraViewport = bounds;
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
        limitCameraHeight(camera.position, target, !perspective);
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
        return [...this.selection].map(id => this.objects.get(id)).filter(Boolean);
    }
    focus(onlyWhenHidden = false) {
        const objects = this.focusObjects();
        if (!objects.length || (onlyWhenHidden && objects.every(object => this.isVisible(object.userData.exhibitId)))) return;
        this.cancelTransform();
        const exhibit = this.data?.exhibits.find(record => {
            const group = this.objects.get(record.id);
            return group === objects[0] || group?.children.length === 1 && group.children[0] === objects[0];
        });
        const preset = objects.length === 1 ? exhibit?.views?.[viewKey(this.mode)] : null;
        if (preset) this.applyView(this.focusView(exhibit.id, preset));
        else this.applyView(this.automaticView(objects, this.mode, objects.length === 1 ? exhibit : null), this.mode, { orbit: true });
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
        cancelAnimationFrame(this.hoverFrame);
        this.pointerEvents?.abort();
        this.observer?.disconnect();
        this.controls?.dispose();
        this.transform?.dispose();
        dispose(this.scene, this.sharedMaterials);
        disposeMaterials(this.sharedMaterials);
        this.topView?.dispose();
        this.overlays?.destroy();
        this.renderer?.dispose();
        this.renderer?.domElement.remove();
    }
}
