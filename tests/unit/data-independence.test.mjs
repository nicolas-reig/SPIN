import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EditSession, identity } from '../../frontend/js/domain.js';
import { editSnapshot, restoreEditSnapshot } from '../../frontend/js/drafts.js';

// Compare observable edit behavior with the review's fixed source baseline.
// Only source modules are read; fixtures never open content folders or models.
const baselineSource = path => readFileSync(new URL('../fixtures/source-baseline/' + path, import.meta.url), 'utf8');
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const baselineDomainUrl = moduleUrl(baselineSource('domain.js'));
const baselineDomain = await import(baselineDomainUrl);
const baselineDrafts = await import(moduleUrl(baselineSource('drafts.js')
    .replace("'./domain.js'", JSON.stringify(baselineDomainUrl))));

function random(seed) {
    let state = seed >>> 0;
    return count => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % count;
    };
}

function placement(next) {
    const coordinates = [-100000, -731.25, -.001, 0, .001, 953.75, 100000];
    const scales = [.001, .01, .5, 1, 2.5, 1000];
    return {
        position: Array.from({ length: 3 }, () => coordinates[next(coordinates.length)]),
        rotation: Array.from({ length: 3 }, () => coordinates[next(coordinates.length)]),
        scale: Array.from({ length: 3 }, () => scales[next(scales.length)])
    };
}

function view(next) {
    return { position: [next(199999) - 99999, 1 + next(99999), next(199999) - 99999],
        target: [0, 0, 0], span: [.001, 17.5, 100000][next(3)] };
}

function fixture(seed, next) {
    const floors = [-17 - seed, 23 + seed, 301 + seed].map(id => ({
        id: String(id), order: id, names: { de: `Ebene ${id}`, en: `Level ${id}` },
        modelId: null, transform: identity(), views: { top: view(next) }, revision: `floor-${id}`
    }));
    const hardware = ['Gerät Ä', 'Spare Display', '__proto__', 'constructor'].map(name => ({
        id: `HardwareModels/${name}.glb`, name, file: `HardwareModels/${name}.glb`,
        url: `api.php?synthetic=${encodeURIComponent(name)}`, kind: 'hardware'
    }));
    const record = (id, number) => {
        const count = [0, 1, 4, 13][next(4)];
        return {
            id, name: id, floorId: count || next(2) ? floors[next(floors.length)].id : null,
            status: ['ok', 'problem', 'retired'][next(3)], transform: placement(next),
            models: Array.from({ length: count }, () => ({
                model: hardware[next(hardware.length)].id, transform: placement(next)
            })), views: number % 2 ? { three: view(next) } : {},
            notes: [{ id: `note-${number}`, body: `Unrelated synthetic text ${seed}-${number}` }],
            links: [{ id: `link-${number}`, title: 'Manual', url: 'https://example.org/manual' }],
            revision: `revision-${seed}-${number}`, contentTag: `content-${seed}-${number}`,
            createdAt: '2026-01-01T00:00:00Z'
        };
    };
    const names = ['__proto__', 'constructor', `Raum Ä ${seed}`, `Level-less ${seed}`, `展示 ${seed}`];
    const snapshot = { datasetKey: `arbitrary-${seed}`, revision: 'snapshot', structureRevision: 'structure',
        floors, assets: hardware, exhibits: names.map(record) };
    snapshot.exhibits.forEach(item => { item.placed = Boolean(item.floorId && item.models.length); });
    return { snapshot, record };
}

test('seeded arbitrary datasets preserve baseline edits, undo, payloads and compact draft recovery', () => {
    for (let seed = 1; seed <= 16; seed++) {
        const next = random(seed);
        const { snapshot, record } = fixture(seed, next);
        const input = JSON.stringify(snapshot);
        const current = new EditSession(snapshot);
        const baseline = new baselineDomain.EditSession(structuredClone(snapshot));
        for (let step = 0; step < 50; step++) {
            const operation = next(10);
            const index = next(Math.max(1, baseline.value.exhibits.length));
            const transform = placement(next);
            const preset = view(next);
            const presetKey = next(2) ? '2D' : '3D';
            const newRecord = record(`New ${seed}-${step}`, 1000 + step);
            newRecord.revision = null;
            const change = state => {
                const item = state.exhibits[index];
                if (!item || operation === 6) {
                    state.exhibits.push(structuredClone(newRecord));
                } else if (operation === 0) item.transform = structuredClone(transform);
                else if (operation === 1) item.name = `Renamed ${seed}-${step}`;
                else if (operation === 2) {
                    if (item.models.length && nextModelRemoval) item.models.pop();
                    else item.models.push({ model: state.assets[modelIndex].id, transform: structuredClone(transform) });
                    if (item.models.length && item.floorId === null) item.floorId = state.floors[0].id;
                } else if (operation === 3) item.views[presetKey] = structuredClone(preset);
                else if (operation === 4) delete item.views[presetKey];
                else if (operation === 5) state.exhibits.splice(index, 1);
                else item.status = ['ok', 'problem', 'retired'][statusIndex];
                state.exhibits.forEach(value => { value.placed = Boolean(value.floorId && value.models.length); });
            };
            const nextModelRemoval = Boolean(next(2));
            const modelIndex = next(snapshot.assets.length);
            const statusIndex = next(3);
            if (operation === 8) { current.undo(); baseline.undo(); }
            else if (operation === 9) { current.redo(); baseline.redo(); }
            else assert.equal(current.change(change), baseline.change(change));

            const context = `seed ${seed}, step ${step}, operation ${operation}`;
            assert.deepEqual(current.base, baseline.base, context);
            assert.deepEqual(current.value, baseline.value, context);
            assert.deepEqual(current.changes(), baseline.changes(), context);
            assert.equal(current.undoStack.length, baseline.undoStack.length, context);
            assert.equal(current.redoStack.length, baseline.redoStack.length, context);
            if (step % 7 === 0) {
                for (const [candidate, original] of [[current.base, baseline.base], [current.value, baseline.value],
                    ...current.undoStack.map((value, i) => [value, baseline.undoStack[i]])]) {
                    const compact = JSON.parse(JSON.stringify(editSnapshot(candidate)));
                    const legacy = JSON.parse(JSON.stringify(baselineDrafts.editSnapshot(original)));
                    assert.equal(Object.hasOwn(compact, 'floors'), false);
                    assert.equal(Object.hasOwn(compact, 'assets'), false);
                    const expected = baselineDrafts.restoreEditSnapshot(legacy, snapshot);
                    assert.deepEqual(restoreEditSnapshot(compact, snapshot), expected, context);
                    assert.deepEqual(restoreEditSnapshot(legacy, snapshot), expected, context);
                }
            }
        }
        assert.equal(JSON.stringify(snapshot), input, `input mutation for seed ${seed}`);
    }
});
