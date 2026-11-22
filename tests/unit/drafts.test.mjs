import test from 'node:test';
import assert from 'node:assert/strict';
import { batchDraftKey, draftRecipients, editSnapshot, restoreEditSnapshot } from '../../frontend/js/drafts.js';

function fixture() {
    return {
        datasetKey: 'synthetic-dataset', structureRevision: 'synthetic-structure',
        floors: [{ id: '13', names: { de: 'Test', en: 'Test' }, views: {} }],
        assets: [{ id: 'HardwareModels/Test.glb', name: 'Test' }],
        exhibits: [{ id: 'Alpha', name: 'Renamed Alpha', views: {}, joinedFrom: ['Beta'],
            notes: [{ id: 'old-note' }], links: [{ id: 'old-link' }], revision: 'base-revision' }]
    };
}

test('batch draft keys preserve the same recipients across selection order and renames', () => {
    const alpha = 'Alpha, Nord';
    const beta = 'Béta';
    const key = batchDraftKey(new Set([beta, alpha]));
    assert.equal(key, batchDraftKey([alpha, beta]));
    assert.deepEqual(draftRecipients(key), [alpha, beta]);
    assert.deepEqual(draftRecipients(alpha), [alpha]);
    const renamed = batchDraftKey(draftRecipients(key).map(id => id === beta ? 'East' : id));
    assert.deepEqual(draftRecipients(renamed), [alpha, 'East']);
    assert.deepEqual(draftRecipients(':malformed'), []);
});

test('persisted edit snapshots omit read-only collections and content while keeping edit state', () => {
    const input = fixture();
    const saved = editSnapshot(input);
    assert.deepEqual(Object.keys(saved).sort(), ['datasetKey', 'exhibits', 'structureRevision']);
    assert.deepEqual(saved.exhibits[0], {
        id: 'Alpha', name: 'Renamed Alpha', views: {}, joinedFrom: ['Beta'], revision: 'base-revision'
    });
    assert.ok(input.floors && input.assets && input.exhibits[0].notes && input.exhibits[0].links);
});

test('both compact and legacy edit snapshots restore live collections and joined content', () => {
    const input = fixture();
    const live = { ...fixture(), exhibits: [
        { id: 'Alpha', notes: [{ id: 'current-note' }], links: [] },
        { id: 'Beta', notes: [], links: [{ id: 'joined-link' }] }
    ] };
    for (const saved of [editSnapshot(input), input]) {
        const restored = restoreEditSnapshot(JSON.parse(JSON.stringify(saved)), live);
        assert.deepEqual(restored.floors, live.floors);
        assert.notEqual(restored.floors, live.floors);
        assert.equal(restored.assets, live.assets);
        assert.equal(restored.exhibits[0].name, 'Renamed Alpha');
        assert.equal(restored.exhibits[0].revision, 'base-revision');
        assert.deepEqual(restored.exhibits[0].notes, [{ id: 'current-note' }]);
        assert.deepEqual(restored.exhibits[0].links, [{ id: 'joined-link' }]);
    }
});

test('serialized undo and redo states do not repeat the static model library', () => {
    const input = fixture();
    input.assets = Array.from({ length: 1000 }, (_, index) => ({ id: 'HardwareModels/Synthetic-' + index + '.glb' }));
    const payload = { base: editSnapshot(input), value: editSnapshot(input),
        undoStack: Array.from({ length: 12 }, () => editSnapshot(input)), redoStack: [editSnapshot(input)] };
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('HardwareModels/'), false);
    for (const state of [payload.base, payload.value, ...payload.undoStack, ...payload.redoStack]) {
        assert.equal(restoreEditSnapshot(state, input).assets, input.assets);
    }
});
