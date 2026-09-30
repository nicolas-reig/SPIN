import * as THREE from 'three';
import {
    GLTFLoader
} from 'three/addons/loaders/GLTFLoader.js';
import {
    OrbitControls
} from 'three/addons/controls/OrbitControls.js';
import {
    TransformControls
} from 'three/addons/controls/TransformControls.js';

import { cameraMode, cameraOffset, navigationGesture } from './camera.js';
import { STATUS_COLORS, SELECTION_COLORS } from './domain.js';

const radians = v => v * Math.PI / 180;

function applyTransform(object, t) {
    object.position.fromArray(t.position);
    object.rotation.set(...t.rotation.map(radians));
    object.scale.fromArray(t.scale);
}

function disposeMaterials(materials) {
    const textures = new Set();
    for (const material of materials) {
        for (const value of Object.values(material)) {
            if (value?.isTexture) textures.add(value);
        }
        material.dispose();
    }
    for (const texture of textures) texture.dispose();
}

function replaceMaterials(object, material) {
    const originals = new Set();
    object.traverse(mesh => {
        if (!mesh.isMesh) return;
        for (const original of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (original && original !== material) originals.add(original);
        }
        mesh.material = material;
    });
    disposeMaterials(originals);
}

function dispose(object, keepMaterials = new Set()) {
    const geometries = new Set();
    const materials = new Set();
    object.traverse(o => {
        if (o.geometry) geometries.add(o.geometry);
        if (o.material) {
            for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
                if (!keepMaterials.has(material)) materials.add(material);
            }
        }
    });
    for (const geometry of geometries) geometry.dispose();
    disposeMaterials(materials);
}
export class MapView {
    constructor(container, {
        onSelect = () => {},
        onTransform = () => {},
        onState = () => {},
        onMode = () => {}
    } = {}) {
        this.container = container;
        this.onSelect = onSelect;
        this.onTransform = onTransform;
        this.onState = onState;
        this.onMode = onMode;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#e8edf0');
        this.root = new THREE.Group();
        this.scene.add(this.root);
        this.objects = new Map();
        this.materials = Object.fromEntries(Object.entries({
            ...STATUS_COLORS,
            selection: SELECTION_COLORS.normal,
            editSelection: SELECTION_COLORS.edit,
            floor: '#c4c9ce'
        }).map(([name, color]) => {
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
        this.generation = 0;
        this.mode = 'perspective';
        this.selected = null;
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
        if (new URLSearchParams(location.search).has('no3d')) throw Error('mapUnavailable');
        this.renderer = new THREE.WebGPURenderer({
            antialias: true,
            forceWebGL: new URLSearchParams(location.search).has('webgl')
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
        this.controls.minDistance = 2;
        this.controls.maxDistance = 450;
        this.controls.maxPolarAngle = Math.PI / 2 - .045;
        this.controls.minPolarAngle = .02;
        this.controls.addEventListener('change', () => this.requestRender());
        this.controls.addEventListener('start', () => cancelAnimationFrame(this.cameraFrame));
        this.transform = new TransformControls(this.camera, this.renderer.domElement);
        this.scene.add(this.transform.getHelper());
        this.transform.addEventListener('dragging-changed', e => {
            this.controls.enabled = !e.value;
            if (!e.value && this.transform.object) {
                const o = this.transform.object;
                this.onTransform(o.userData.exhibitId, o.userData.instanceIndex, {
                    position: o.position.toArray(),
                    rotation: [o.rotation.x, o.rotation.y, o.rotation.z].map(v => v * 180 / Math.PI),
                    scale: o.scale.toArray()
                });
            }
        });
        this.transform.addEventListener('change', () => this.requestRender());
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.container);
        const canvas = this.renderer.domElement;
        canvas.addEventListener('pointerdown', e => {
            e.preventDefault();
            getSelection()?.removeAllRanges();
            this.down = [e.clientX, e.clientY];
            this.orbitFromTop = navigationGesture(e.button, e.shiftKey, this.mode).leaveTop ? { button: e.button, shiftKey: e.shiftKey, clientX: e.clientX, clientY: e.clientY } : null;
        });
        canvas.addEventListener('pointermove', e => {
            if (!this.orbitFromTop || !e.buttons || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) <= 5) return;
            const gesture = this.orbitFromTop;
            this.orbitFromTop = null;
            this.setView('perspective', true);
            this.onMode('perspective');
            this.controls._onMouseDown(gesture);
        }, true);
        canvas.addEventListener('pointercancel', () => { this.down = null; this.orbitFromTop = null; });
        canvas.addEventListener('pointerup', e => {
            this.orbitFromTop = null;
            if (e.button !== 0 || e.shiftKey || !this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 5 || this.transform.dragging || this.transform.axis) return;
            const r = canvas.getBoundingClientRect();
            const pointer = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
            const ray = new THREE.Raycaster();
            ray.setFromCamera(pointer, this.camera);
            const hits = ray.intersectObjects([...this.objects.values()], true);
            for (const h of hits) {
                let o = h.object;
                while (o && !o.userData.exhibitId) o = o.parent;
                if (o) {
                    this.onSelect(o.userData.exhibitId, o.userData.instanceIndex || 0);
                    return;
                }
            }
            this.onSelect(null);
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
        this.camera.updateProjectionMatrix();
        this.requestRender();
    }
    requestRender() {
        if (this.frame || !this.renderer) return;
        this.frame = requestAnimationFrame(async () => {
            this.frame = 0;
            try {
                const offset = this.camera.position.clone().sub(this.controls.target);
                this.renderer.domElement.dataset.cameraOffset = offset.toArray().join(',');
                await this.renderer.renderAsync(this.scene, this.camera);
            } catch (e) {
                this.onState('mapUnavailable');
            }
        });
    }
    async model(asset, material = this.materials.floor) {
        if (!asset) return new THREE.Group();
        const result = await this.loader.loadAsync(asset.url);
        replaceMaterials(result.scene, material);
        return result.scene;
    }
    async setData(data, floorId, selected, editing = false, {
        reset = false
    } = {}) {
        this.data = data;
        this.selected = selected;
        this.editing = editing;
        const floor = data.floors.find(f => f.id === floorId);
        if (!floor) {
            this.generation++;
            this.transform?.detach();
            this.scene.remove(this.root);
            dispose(this.root, this.sharedMaterials);
            this.root = new THREE.Group();
            this.scene.add(this.root);
            this.objects.clear();
            this.floor = null;
            this.key = null;
            this.requestRender();
            this.onState('mapReady');
            return;
        }
        const key = JSON.stringify([floor, data.exhibits.filter(e => e.floorId === floorId).map(e => [e.id, e.transform, e.models])]);
        if (key === this.key) {
            for (const exhibit of data.exhibits) {
                const object = this.objects.get(exhibit.id);
                if (!object) continue;
                object.userData.status = exhibit.status;
            }
            this.highlight(selected);
            return;
        }
        this.key = key;
        const generation = ++this.generation;
        this.onState('mapLoading');
        this.transform?.detach();
        const next = new THREE.Group();
        applyTransform(next, floor.transform);
        const objects = new Map();
        try {
            const asset = data.assets.find(a => a.id === floor.modelId);
            const building = await this.model(asset);
            building.userData.floor = true;
            next.add(building);
            for (const exhibit of data.exhibits.filter(e => e.floorId === floorId && e.models.length)) {
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
                    holder.add(await this.model(data.assets.find(asset => asset.id === instance.model), this.materials[exhibit.status] || this.materials.ok));
                    group.add(holder);
                }
                objects.set(exhibit.id, group);
            }
            if (generation !== this.generation) {
                dispose(next, this.sharedMaterials);
                return;
            }
            this.scene.remove(this.root);
            dispose(this.root, this.sharedMaterials);
            this.root = next;
            this.scene.add(next);
            this.objects = objects;
            this.floor = floor;
            for (const exhibit of this.data.exhibits) {
                const object = objects.get(exhibit.id);
                if (object) object.userData.status = exhibit.status;
            }
            this.highlight(this.selected);
            if (reset) this.home();
            this.requestRender();
            this.onState('mapReady');
        } catch (e) {
            dispose(next, this.sharedMaterials);
            if (generation === this.generation) {
                this.key = null;
                this.onState('mapUnavailable');
            }
        }
    }
    highlight(id) {
        this.selected = id;
        for (const [exhibitId, group] of this.objects) {
            const material = exhibitId === id ?
                this.materials[this.editing ? 'editSelection' : 'selection'] :
                this.materials[group.userData.status] || this.materials.ok;
            group.traverse(mesh => {
                if (mesh.isMesh) mesh.material = material;
            });
        }
        const object = this.objects.get(id);
        if (object && this.editing && this.tool && object.children[this.activeInstance || 0]) {
            this.transform?.attach(object.children[this.activeInstance || 0]);
        }
        else this.transform?.detach();
        this.requestRender();
    }
    setActiveInstance(index) {
        this.activeInstance = index;
        this.highlight(this.selected);
    }
    setTool(tool, snap = false) {
        this.tool = tool;
        this.snap = snap;
        if (!this.transform) return;
        this.transform.setMode(tool || 'translate');
        this.transform.setSpace('local');
        this.transform.setTranslationSnap(snap ? 1 : null);
        this.transform.setRotationSnap(snap ? Math.PI / 12 : null);
        this.transform.setScaleSnap(snap ? .1 : null);
        this.highlight(this.selected);
    }
    frameTarget(center, distance, span, animate = true, position = null) {
        cancelAnimationFrame(this.cameraFrame);
        const offset = new THREE.Vector3(...cameraOffset(this.mode, distance));
        const startTarget = this.controls.target.clone();
        const startPosition = this.camera.position.clone();
        const endPosition = position || center.clone().add(offset);
        const startSpan = this.orthoSpan || span;
        const startZoom = this.camera.zoom;
        const started = performance.now();
        const step = () => {
            const p = !animate || matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : Math.min(1, (performance.now() - started) / 220);
            const ease = 1 - Math.pow(1 - p, 3);
            this.controls.target.copy(startTarget).lerp(center, ease);
            this.camera.position.copy(startPosition).lerp(endPosition, ease);
            this.orthoSpan = startSpan + (span - startSpan) * ease;
            this.camera.zoom = startZoom + (1 - startZoom) * ease;
            this.resize();
            this.controls.update();
            if (p < 1) this.cameraFrame = requestAnimationFrame(step);
        };
        step();
    }
    home() {
        const preset = this.floor?.views?.[this.mode === 'top' ? 'top' : 'three'];
        if (preset) {
            this.applyView({ ...preset, mode: this.mode });
            return;
        }
        this.fit();
    }
    fit() {
        const box = new THREE.Box3().setFromObject(this.root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.z, 10);
        this.frameTarget(center, span * 1.6, span * .65);
    }
    captureView(mode = this.mode) {
        mode = cameraMode(mode);
        const target = this.controls.target.toArray();
        const distance = this.camera.position.distanceTo(this.controls.target);
        const top = mode === 'top';
        return {
            mode,
            position: top && this.mode !== 'top' ? [target[0], target[1] + distance, target[2] + .00001] : !top && this.mode === 'top' ? new THREE.Vector3(...target).add(new THREE.Vector3(...cameraOffset('perspective', distance))).toArray() : this.camera.position.toArray(),
            target,
            span: this.camera.isOrthographicCamera ? this.orthoSpan / this.camera.zoom : Math.max(3, distance * .36)
        };
    }
    fallbackView(ids, mode = this.mode) {
        mode = cameraMode(mode);
        const box = new THREE.Box3();
        for (const id of ids) {
            const object = this.objects.get(id);
            if (object) box.union(new THREE.Box3().setFromObject(object));
        }
        if (box.isEmpty()) box.setFromObject(this.root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const aspect = Math.max(.2, this.container.clientWidth / this.container.clientHeight);
        const span = Math.max(4, size.y, size.z, size.x / aspect) * .7;
        const distance = Math.max(9, span * 3.2);
        return { mode, target: center.toArray(), position: center.clone().add(new THREE.Vector3(...cameraOffset(mode, distance))).toArray(), span };
    }
    applyView(preset) {
        if (!preset) return;
        const mode = cameraMode(preset.mode);
        if (this.mode !== mode) {
            this.setView(mode, true);
            this.onMode(mode);
        }
        const center = new THREE.Vector3(...preset.target);
        const position = new THREE.Vector3(...preset.position);
        this.frameTarget(center, center.distanceTo(position), preset.span, true, position);
    }
    viewportBounds() {
        const rect = this.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return { left: -.94, right: .94, top: .94, bottom: -.94 };
        const inset = Math.min(16, rect.width * .05) / rect.width * 2;
        return {
            left: -1 + inset,
            right: 1 - inset,
            top: .94,
            bottom: -.94
        };
    }
    isVisible(id, camera = this.camera) {
        const object = this.objects.get(id);
        if (!object) return false;
        camera.updateMatrixWorld();
        const bounds = this.viewportBounds();
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3()).project(camera);
        if (center.z < -1 || center.z > 1) return false;
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x, y, z).project(camera);
            if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.bottom || point.y > bounds.top || point.z > 1 || point.z < -1) return false;
        }
        return true;
    }
    focusView(id, preset) {
        preset = { ...preset, mode: cameraMode(preset.mode) };
        const aspect = this.width / this.height;
        const perspective = preset.mode === 'perspective';
        const camera = perspective ? new THREE.PerspectiveCamera(38, aspect, .05, 2000) :
            new THREE.OrthographicCamera(-preset.span * aspect, preset.span * aspect, preset.span, -preset.span, .05, 2000);
        const target = new THREE.Vector3(...preset.target);
        camera.position.fromArray(preset.position);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        if (this.isVisible(id, camera)) return preset;
        const box = new THREE.Box3().setFromObject(this.objects.get(id));
        const bounds = this.viewportBounds();
        const points = [];
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
            points.push(new THREE.Vector3(x, y, z).project(camera));
        }
        const scale = Math.max(1,
            (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))) / (bounds.right - bounds.left),
            (Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))) / (bounds.top - bounds.bottom));
        if (perspective) {
            camera.position.sub(target).multiplyScalar(scale).add(target);
        } else {
            camera.left *= scale;
            camera.right *= scale;
            camera.top *= scale;
            camera.bottom *= scale;
        }
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const center = box.getCenter(new THREE.Vector3());
        const projected = center.clone().project(camera);
        const depth = -center.clone().applyMatrix4(camera.matrixWorldInverse).z;
        const halfWidth = (perspective ? Math.tan(THREE.MathUtils.degToRad(19)) * depth : preset.span * scale) * aspect;
        const shift = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
            .multiplyScalar((projected.x - (bounds.left + bounds.right) / 2) * halfWidth);
        return { ...preset, target: target.add(shift).toArray(), position: camera.position.add(shift).toArray(), span: preset.span * scale };
    }
    focus(onlyWhenHidden = false) {
        const exhibit = this.data.exhibits.find(e => e.id === this.selected);
        if (!exhibit?.models.length || !this.objects.has(exhibit.id) || (onlyWhenHidden && this.isVisible(exhibit.id))) return;
        const key = this.mode === 'top' ? 'top' : 'three';
        const preset = exhibit.views?.[key] || this.fallbackView([exhibit.id]);
        this.applyView(this.focusView(exhibit.id, preset));
    }
    focusFloor() {
        const ids = this.data.exhibits.filter(exhibit => exhibit.floorId === this.floor.id).map(exhibit => exhibit.id);
        const key = this.mode === 'top' ? 'top' : 'three';
        this.applyView(this.floor.views?.[key] || this.fallbackView(ids));
    }
    setView(mode, preserve = false) {
        mode = cameraMode(mode);
        cancelAnimationFrame(this.cameraFrame);
        const target = this.controls.target.clone();
        const distance = this.camera.position.distanceTo(target);
        this.mode = mode;
        const old = this.camera;
        this.camera = mode === 'perspective' ? new THREE.PerspectiveCamera(38, 1, .05, 2000) : new THREE.OrthographicCamera(-20, 20, 20, -20, .05, 2000);
        const halfFov = Math.tan(THREE.MathUtils.degToRad(19));
        this.orthoSpan = old.isOrthographicCamera ? this.orthoSpan / old.zoom : distance * halfFov / old.zoom;
        const nextDistance = mode === 'perspective' && old.isOrthographicCamera ? this.orthoSpan / halfFov : distance;
        const offset = !preserve ? new THREE.Vector3(...cameraOffset(mode, nextDistance)) :
            old.position.clone().sub(target).normalize().multiplyScalar(nextDistance);
        this.camera.position.copy(target).add(offset);
        this.controls.object = this.camera;
        this.controls.enableRotate = mode !== 'top';
        this.controls.minPolarAngle = mode === 'top' ? 0 : .02;
        this.renderer.domElement.dataset.view = mode;
        this.renderer.domElement.dataset.projection = this.camera.isOrthographicCamera ? 'orthographic' : 'perspective';
        this.transform.camera = this.camera;
        this.resize();
        this.controls.update();
    }
    command(action) {
        if (action === 'home') return this.home();
        if (action === 'fit') return this.fit();
        if (action === 'focus') return this.focus();
        if (['top', 'perspective'].includes(action)) return this.setView(action);
        if (action === 'zoomIn' || action === 'zoomOut') {
            const factor = action === 'zoomIn' ? .8 : 1.25;
            if (this.camera.isOrthographicCamera) {
                this.camera.zoom = Math.min(15, Math.max(.1, this.camera.zoom / factor));
                this.camera.updateProjectionMatrix();
            } else {
                const v = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
                v.clampLength(2, 450);
                this.camera.position.copy(this.controls.target).add(v);
            }
        }
        if (action === 'rotate' && this.mode !== 'top') {
            const offset = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 12);
            this.camera.position.copy(this.controls.target).add(offset);
        }
        const deltas = {
            panLeft: [-2, 0, 0],
            panRight: [2, 0, 0],
            panUp: [0, 0, -2],
            panDown: [0, 0, 2]
        };
        if (deltas[action]) {
            const d = new THREE.Vector3(...deltas[action]);
            this.camera.position.add(d);
            this.controls.target.add(d);
        }
        this.controls.update();
        this.requestRender();
    }
    setAxis(axis) {
        if (!this.transform) return;
        this.transform.showX = !axis || axis === 'X';
        this.transform.showY = !axis || axis === 'Y';
        this.transform.showZ = !axis || axis === 'Z';
        this.requestRender();
    }
    async preview(asset) {
        const material = asset.kind === 'floor' ? this.materials.floor : this.materials.ok;
        const model = await this.model(asset, material);
        this.scene.remove(this.root);
        dispose(this.root, this.sharedMaterials);
        this.root = model;
        this.scene.add(model);
        this.fit();
    }
    destroy() {
        this.generation++;
        cancelAnimationFrame(this.frame);
        cancelAnimationFrame(this.cameraFrame);
        this.observer?.disconnect();
        this.controls?.dispose();
        this.transform?.dispose();
        dispose(this.scene, this.sharedMaterials);
        disposeMaterials(this.sharedMaterials);
        this.renderer?.dispose();
        this.renderer?.domElement.remove();
    }
}
export async function inspectModel(file) {
    const bytes = await file.arrayBuffer();
    const view = new DataView(bytes);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw Error('invalidModel');
    const length = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
    if ([...(json.buffers || []), ...(json.images || [])].some(x => x.uri)) throw Error('externalModelResource');
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3()).toArray();
    dispose(gltf.scene);
    return size;
}
