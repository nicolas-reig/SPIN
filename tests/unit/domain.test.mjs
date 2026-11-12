import test from 'node:test';
import assert from 'node:assert/strict';
import { EditSession, identity, structural } from '../../frontend/js/domain.js';

const exhibit = id => ({
    id, name: id, floorId: '-7', status: 'ok', transform: identity(),
    models: [{ model: 'HardwareModels/Synthetic.glb', transform: identity() }], views: {},
    revision: 'revision-' + id, contentTag: 'content-' + id,
    notes: [{ id: 'note-' + id, body: 'Synthetic content' }], links: []
});
const snapshot = ids => ({
    revision: 'revision', structureRevision: 'structure', datasetKey: 'synthetic',
    floors: [{ id: '-7', names: { de: 'Test', en: 'Test' }, views: {
        top: { position: [0, 10, 1], target: [0, 0, 0], span: 8 }
    } }],
    assets: [{ id: 'HardwareModels/Synthetic.glb', name: 'Synthetic', file: 'HardwareModels/Synthetic.glb' }],
    exhibits: ids.map(exhibit)
});

test('edit history shares isolated read-only collections and retains live content references', () => {
    const input = snapshot(['Alpha']);
    const session = new EditSession(input);
    assert.notEqual(session.base.floors, input.floors);
    assert.notEqual(session.base.assets, input.assets);
    assert.equal(session.base.floors, session.value.floors);
    assert.equal(session.base.assets, session.value.assets);
    assert.deepEqual(Object.keys(session.base.floors[0].views), ['2D']);
    assert.ok(input.floors[0].views.top);
    assert.equal(session.value.exhibits[0].notes, input.exhibits[0].notes);

    input.floors[0].names.en = 'Changed externally';
    input.floors[0].views.top.position[1] = 500;
    input.assets[0].name = 'Changed externally';
    input.exhibits[0].transform.position[0] = 500;
    assert.equal(session.value.floors[0].names.en, 'Test');
    assert.equal(session.value.floors[0].views['2D'].position[1], 10);
    assert.equal(session.value.assets[0].name, 'Synthetic');
    assert.equal(session.value.exhibits[0].transform.position[0], 0);

    session.change(state => { state.exhibits[0].transform.position[0] = 4; });
    session.change(state => { state.exhibits[0].models[0].transform.rotation[1] = 45; });
    for (const state of [session.base, session.value, ...session.undoStack]) {
        assert.equal(state.floors, session.base.floors);
        assert.equal(state.assets, session.base.assets);
    }
    session.undo();
    assert.equal(session.value.exhibits[0].transform.position[0], 4);
    assert.equal(session.value.exhibits[0].models[0].transform.rotation[1], 0);
    session.redo();
    assert.equal(session.value.exhibits[0].models[0].transform.rotation[1], 45);
    assert.equal(session.base.exhibits[0].models[0].transform.rotation[1], 0);
});

test('indexed changes retain join, rename, creation and deletion payload order', () => {
    const session = new EditSession(snapshot(['Alpha', 'Beta', 'Gamma', 'Delta']));
    session.change(state => {
        state.exhibits[0].joinedFrom = ['Beta'];
        state.exhibits[2].name = 'Renamed Gamma';
        state.exhibits = [state.exhibits[0], state.exhibits[2], { ...exhibit('Epsilon'), revision: null }];
    });
    const changes = session.changes();
    assert.deepEqual(changes.map(({ op, id }) => [op, id]), [
        ['put', 'Alpha'], ['put', 'Gamma'], ['put', 'Epsilon'], ['delete', 'Delta']
    ]);
    assert.deepEqual(changes[0], {
        kind: 'exhibits', op: 'put', id: 'Alpha', record: structural(session.value.exhibits[0]),
        baseRevision: 'revision-Alpha', contentTag: 'content-Alpha',
        joins: [{ id: 'Beta', baseRevision: 'revision-Beta', contentTag: 'content-Beta' }]
    });
    assert.equal(changes[1].record.name, 'Renamed Gamma');
    assert.equal(changes[2].baseRevision, undefined);
    assert.deepEqual(changes[3], {
        kind: 'exhibits', op: 'delete', id: 'Delta', baseRevision: 'revision-Delta', contentTag: 'content-Delta'
    });
});

test('no-op changes do not create history and refreshed content survives undo and redo', () => {
    const session = new EditSession(snapshot(['Alpha']));
    assert.equal(session.change(() => {}), false);
    assert.deepEqual(session.changes(), []);
    assert.equal(session.undoStack.length, 0);
    session.change(state => { state.exhibits[0].name = 'Renamed'; });
    const notes = [{ id: 'new-note', body: 'Refreshed separately' }];
    const links = [{ id: 'new-link', url: 'https://example.org' }];
    session.base.exhibits[0].notes = session.value.exhibits[0].notes = notes;
    session.base.exhibits[0].links = session.value.exhibits[0].links = links;
    session.undo();
    assert.equal(session.value.exhibits[0].name, 'Alpha');
    assert.deepEqual(session.changes(), []);
    assert.deepEqual(session.value.exhibits[0].notes, notes);
    session.redo();
    assert.equal(session.value.exhibits[0].name, 'Renamed');
    assert.deepEqual(session.value.exhibits[0].links, links);
});
