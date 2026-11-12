import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../frontend/js/app.js', import.meta.url), 'utf8');
const refreshSource = source.slice(source.indexOf('let fileRefreshInFlight = false;'), source.indexOf('\nsetInterval(refreshFromFiles'));
assert.ok(refreshSource.includes('async function refreshFromFiles()'));
const snapshot = revision => ({ revision, structureRevision: revision, exhibits: [] });

function harness() {
    let calls = 0;
    const pending = [];
    const document = { hidden: false, activeElement: null };
    const dialog = { open: false };
    const api = { load() {
        calls++;
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } };
    const build = new Function('api', 'document', 'dialog', 'initial', `
        let snapshot = initial, edit = null, statusSaving = false;
        const accepted = [];
        const $ = () => dialog;
        const acceptSnapshot = value => { snapshot = value; accepted.push(value); };
        ${refreshSource}
        return { refresh: refreshFromFiles, accepted,
            setEdit: value => { edit = value; }, setStatusSaving: value => { statusSaving = value; },
            setSnapshot: value => { snapshot = value; } };
    `);
    return { ...build(api, document, dialog, snapshot('old')), document, dialog, pending, get calls() { return calls; } };
}

test('overlapping file refresh triggers keep only one full snapshot request in flight', async () => {
    const h = harness();
    const first = h.refresh();
    await h.refresh();
    await h.refresh();
    assert.equal(h.calls, 1);
    h.pending[0].resolve(snapshot('new'));
    await first;
    assert.equal(h.accepted.length, 1);
    const second = h.refresh();
    assert.equal(h.calls, 2);
    h.pending[1].resolve(snapshot('new'));
    await second;
    assert.equal(h.accepted.length, 1);
});

test('delayed file responses cannot interrupt editing, saving, focused inputs or hidden pages', async () => {
    const blockers = [
        h => h.setEdit({}), h => h.setStatusSaving(true), h => { h.dialog.open = true; },
        h => { h.document.hidden = true; },
        h => { h.document.activeElement = { closest: () => ({}) }; }
    ];
    for (const block of blockers) {
        const h = harness();
        const pending = h.refresh();
        block(h);
        h.pending[0].resolve(snapshot('delayed'));
        await pending;
        assert.equal(h.accepted.length, 0);
    }
});

test('a delayed file response cannot replace a newer accepted snapshot', async () => {
    const h = harness();
    const pending = h.refresh();
    h.setSnapshot(snapshot('newer-save'));
    h.pending[0].resolve(snapshot('older-response'));
    await pending;
    assert.equal(h.accepted.length, 0);
});

test('failed refreshes release the request gate and blocked states do not issue requests', async () => {
    const h = harness();
    h.setEdit({});
    await h.refresh();
    assert.equal(h.calls, 0);
    h.setEdit(null);
    const failed = h.refresh();
    h.pending[0].reject(Error('offline'));
    await failed;
    const recovered = h.refresh();
    assert.equal(h.calls, 2);
    h.pending[1].resolve(snapshot('recovered'));
    await recovered;
    assert.equal(h.accepted.length, 1);
});

test('empty searches keep floor and status filtering without reading post bodies', () => {
    const start = source.indexOf('    const records = data().exhibits.filter(e => {', source.indexOf('function renderList()'));
    const end = source.indexOf('\n    const filtered =', start);
    const searchSource = source.slice(start, end);
    const search = new Function('records', 'q', 'floorFilter', 'appliedStatusFilter', 'scope', `
        const data = () => ({ exhibits: records });
        const lang = () => 'en';
        ${searchSource.replace('const records =', 'const result =')}
        return result;
    `);
    const records = [
        { id: 'Alpha', floorId: '-7', placed: true, status: 'ok', get notes() { throw Error('unneeded post allocation'); } },
        { id: 'Beta', floorId: '13', placed: true, status: 'problem' },
        { id: 'Gamma', floorId: null, placed: false, status: 'ok' }
    ];
    assert.deepEqual(search(records, '', '-7', 'ok', 'notes').map(record => record.id), ['Alpha']);
    assert.deepEqual(search(records, '', 'unplaced', '', 'notes').map(record => record.id), ['Gamma']);
});
