import * as THREE from 'three';
import {
    color, mix, texture
} from 'three/tsl';
import {
    GLTFLoader
} from 'three/addons/loaders/GLTFLoader.js';
import {
    OrbitControls
} from 'three/addons/controls/OrbitControls.js';
import {
    TransformControls
} from 'three/addons/controls/TransformControls.js';

const radians = v => v * Math.PI / 180;

function applyTransform(object, t) {
    object.position.fromArray(t.position);
    object.rotation.set(...t.rotation.map(radians));
    object.scale.fromArray(t.scale);
}

function dispose(object) {
    object.traverse(o => {
        o.geometry?.dispose();
        if (o.material)
            for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
                for (const v of Object.values(m))
                    if (v?.isTexture) v.dispose();
                m.dispose();
            }
    });
}
export class MapView {
    constructor(container, {
        onSelect = () => {},
        onTransform = () => {},
        onState = () => {}
    } = {}) {
        this.container = container;
        this.onSelect = onSelect;
        this.onTransform = onTransform;
        this.onState = onState;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#e8edf0');
        this.root = new THREE.Group();
        this.scene.add(this.root);
        this.objects = new Map();
        this.generation = 0;
        this.mode = 'iso';
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
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.05;
        await this.renderer.init();
        this.container.append(this.renderer.domElement);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = false;
        this.controls.minDistance = 2;
        this.controls.maxDistance = 450;
        this.controls.maxPolarAngle = Math.PI / 2 - .045;
        this.controls.minPolarAngle = .02;
        this.controls.addEventListener('change', () => this.requestRender());
        this.transform = new TransformControls(this.camera, this.renderer.domElement);
        this.scene.add(this.transform.getHelper());
        this.transform.addEventListener('dragging-changed', e => {
            this.controls.enabled = !e.value;
            if (!e.value && this.transform.object) {
                const o = this.transform.object;
                this.onTransform(o.userData.exhibitId, {
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
            this.down = [e.clientX, e.clientY];
        });
        canvas.addEventListener('pointerup', e => {
            if (!this.down || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 5 || this.transform.dragging || this.transform.axis) return;
            const r = canvas.getBoundingClientRect();
            const pointer = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
            const ray = new THREE.Raycaster();
            ray.setFromCamera(pointer, this.camera);
            const hits = ray.intersectObjects([...this.objects.values()], true);
            for (const h of hits) {
                let o = h.object;
                while (o && !o.userData.exhibitId) o = o.parent;
                if (o) {
                    this.onSelect(o.userData.exhibitId);
                    break;
                }
            }
        });
        this.resize();
        return this;
    }
    resize() {
        if (!this.renderer) return;
        const w = this.container.clientWidth,
            h = this.container.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h);
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
                await this.renderer.renderAsync(this.scene, this.camera);
            } catch (e) {
                this.onState('mapUnavailable');
            }
        });
    }
    async model(asset) {
        if (!asset) return new THREE.Group();
        const result = await this.loader.loadAsync(asset.url);
        return result.scene;
    }
    async setData(data, floorId, selected, editing = false, {
        reset = false
    } = {}) {
        this.data = data;
        this.selected = selected;
        this.editing = editing;
        const floor = data.floors.find(f => f.id === floorId);
        if (!floor) return;
        const key = JSON.stringify([floor, data.exhibits.filter(e => e.floorId === floorId).map(e => [e.id, e.modelId, e.transform, e.placed, e.status])]);
        if (key === this.key) {
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
            building.traverse(object => {
                if (!object.isMesh || !object.name.includes('Grundriss')) return;
                const original = object.material;
                if (original?.map) {
                    const material = new THREE.MeshBasicNodeMaterial();
                    material.colorNode = mix(color('#e1e4e7'), texture(original.map), 0.32);
                    material.side = THREE.DoubleSide;
                    object.material = material;
                    original.dispose();
                }
            });
            next.add(building);
            for (const exhibit of data.exhibits.filter(e => e.floorId === floorId && e.placed)) {
                const group = new THREE.Group();
                group.userData.exhibitId = exhibit.id;
                applyTransform(group, exhibit.transform);
                if (exhibit.modelId) group.add(await this.model(data.assets.find(a => a.id === exhibit.modelId)));
                const bounds = new THREE.Box3().setFromObject(group);
                const height = Number.isFinite(bounds.max.y) ? Math.max(.5, bounds.max.y - group.position.y) : 1;
                const markerMaterial = new THREE.MeshBasicNodeMaterial();
                markerMaterial.colorNode = color(({
                    ok: '#227247',
                    problem: '#b03d3e',
                    retired: '#5a6572'
                })[exhibit.status]);
                const marker = new THREE.Mesh(new THREE.SphereGeometry(.25, 12, 8), markerMaterial);
                marker.position.set(0, height + .6, 0);
                group.add(marker);
                next.add(group);
                objects.set(exhibit.id, group);
            }
            if (generation !== this.generation) {
                dispose(next);
                return;
            }
            this.scene.remove(this.root);
            dispose(this.root);
            this.root = next;
            this.scene.add(next);
            this.objects = objects;
            this.floor = floor;
            this.highlight(selected);
            if (reset) this.home();
            this.requestRender();
            this.onState('mapReady');
        } catch (e) {
            dispose(next);
            if (generation === this.generation) this.onState('mapUnavailable');
        }
    }
    highlight(id) {
        this.selected = id;
        if (this.outline) {
            this.scene.remove(this.outline);
            this.outline.geometry.dispose();
            this.outline.material.dispose();
            this.outline = null;
        }
        const object = this.objects.get(id);
        if (object) {
            this.root.updateMatrixWorld(true);
            this.outline = new THREE.BoxHelper(object, 0x0876d9);
            this.scene.add(this.outline);
            if (this.editing && this.tool) this.transform?.attach(object);
            else this.transform?.detach();
        } else this.transform?.detach();
        this.requestRender();
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
    home() {
        const p = this.floor?.camera?.position || [28, 27, 33];
        this.controls.target.copy(new THREE.Vector3(0, 1, 0).applyMatrix4(this.root.matrixWorld));
        this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...p));
        this.camera.zoom = 1;
        this.camera.updateProjectionMatrix();
        this.controls.update();
        this.requestRender();
    }
    fit() {
        const box = new THREE.Box3().setFromObject(this.root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.z, 10);
        this.controls.target.copy(center);
        this.camera.position.copy(center).add(new THREE.Vector3(span * .6, span * .85, span * .8));
        if (this.camera.isOrthographicCamera) {
            this.orthoSpan = span * .65;
            this.camera.zoom = 1;
            this.resize();
        }
        this.controls.update();
        this.requestRender();
    }
    focus() {
        const obj = this.objects.get(this.selected);
        if (!obj) return;
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const d = Math.max(9, size.length() * 1.4);
        this.controls.target.copy(center);
        this.camera.position.copy(center).add(new THREE.Vector3(d * .65, d * .75, d));
        if (this.camera.isOrthographicCamera) {
            this.orthoSpan = d;
            this.camera.zoom = 1;
            this.resize();
        }
        this.controls.update();
        this.requestRender();
    }
    setView(mode) {
        const target = this.controls.target.clone();
        const distance = this.camera.position.distanceTo(target);
        this.mode = mode;
        const old = this.camera;
        this.camera = mode === 'perspective' ? new THREE.PerspectiveCamera(38, 1, .05, 2000) : new THREE.OrthographicCamera(-20, 20, 20, -20, .05, 2000);
        this.orthoSpan = Math.max(5, distance * .36);
        this.camera.position.copy(mode === 'top' ? target.clone().add(new THREE.Vector3(0, distance, .001)) : old.position);
        if (mode === 'iso') this.camera.position.copy(target).add(new THREE.Vector3(.65, .8, 1).normalize().multiplyScalar(distance));
        this.controls.object = this.camera;
        this.controls.enableRotate = mode !== 'top';
        this.transform.camera = this.camera;
        this.resize();
        this.controls.update();
    }
    command(action) {
        if (action === 'home') return this.home();
        if (action === 'fit') return this.fit();
        if (action === 'focus') return this.focus();
        if (['top', 'iso', 'perspective'].includes(action)) return this.setView(action);
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
        if (action === 'rotate') {
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
    async preview(asset) {
        const model = await this.model(asset);
        this.scene.remove(this.root);
        dispose(this.root);
        this.root = model;
        this.scene.add(model);
        this.fit();
    }
    destroy() {
        this.generation++;
        cancelAnimationFrame(this.frame);
        this.observer?.disconnect();
        this.controls?.dispose();
        this.transform?.dispose();
        dispose(this.scene);
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
