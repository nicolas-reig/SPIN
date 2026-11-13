import test from 'node:test';
import assert from 'node:assert/strict';
import { identity } from '../../frontend/js/domain.js';
import { hardwareParameters, exhibitParameters } from '../../frontend/js/placement-inspector.js';
import { hardwareSelected, expandExhibitSelection, pickHardwareSelection, wholeHardwareSelection } from '../../frontend/js/transform-selection.js';

const record = id => ({ id, name: id, transform: identity(), models: [{ model: 'Display', transform: identity() }, { model: 'Display', transform: identity() }] });
const assets = [{ id: 'Display', name: 'Display' }];

test('selected component parameters expand and retain their owning exhibit across multiple selections', () => {
    const a = hardwareParameters(record('Alpha'), 1, assets, 'member-0-1');
    const b = hardwareParameters(record('Beta'), 1, assets, 'member-1-1');
    assert.match(a, /data-hardware-placement="1" data-exhibit="Alpha" open/);
    assert.match(a, /data-instance="1" data-exhibit="Alpha"/);
    assert.match(b, /data-instance="1" data-exhibit="Beta"/);
    const ids = [...(a + b).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size);
});

test('whole-exhibit fields are explicitly scoped and can expose hardware selection without mixing targets', () => {
    const selected = exhibitParameters(record('Alpha'), 'exhibit-0', { active: true, showName: true, hardware: true, assets });
    assert.match(selected, /data-exhibit-placement="Alpha" open/);
    assert.match(selected, /data-group-vector data-exhibit="Alpha"/);
    assert.match(selected, /data-edit-instance="1" data-exhibit="Alpha" aria-pressed="false"/);
    assert.match(selected, /Display 2/);
    const contextual = exhibitParameters(record('Alpha'), 'group');
    assert.doesNotMatch(contextual, /data-exhibit-placement="Alpha" open/);
});

test('whole-placement menus display the derived center and wait for geometry instead of showing the parent origin', () => {
    const original = record('Alpha'); original.transform.position = [80, 90, 100];
    const placement = { ...identity(), position: [2, 3, 4] };
    const ready = exhibitParameters(original, 'group', { placement });
    assert.match(ready, /id="transform-group-position-0"[^>]*value="2"/);
    assert.doesNotMatch(ready, /value="80"|data-placement-loading| disabled /);
    const pending = exhibitParameters(original, 'group', { placement: null });
    assert.match(pending, /data-placement-loading/);
    assert.match(pending, /id="transform-group-position-0"[^>]*disabled[^>]*value=""/);
});

test('whole-exhibit selection marks every component selected while explicit component selection leaves its siblings unselected', () => {
    const exhibits = new Set(['Alpha']), hardware = [{ exhibitId: 'Alpha', instanceIndex: 1 }];
    assert.equal(hardwareSelected('Alpha', 0, exhibits, []), true);
    assert.equal(hardwareSelected('Beta', 0, exhibits, []), false);
    assert.equal(hardwareSelected('Alpha', 0, exhibits, hardware), false);
    assert.equal(hardwareSelected('Alpha', 1, exhibits, hardware), true);
    const unselected = hardwareParameters(record('Alpha'), 0, assets, 'component', { selected: false });
    assert.match(unselected, /aria-pressed="false"/);
    assert.doesNotMatch(unselected, /data-hardware-placement="0" data-exhibit="Alpha" open/);
    assert.match(unselected, /data-instance="0" data-exhibit="Alpha"/);
    const wholeSelected = hardwareParameters(record('Alpha'), 0, assets, 'component', { expanded: false });
    assert.match(wholeSelected, /aria-pressed="true"/);
    assert.doesNotMatch(wholeSelected, /data-hardware-placement="0" data-exhibit="Alpha" open/);
});

test('extending an implicit whole-exhibit selection starts with all current-floor components so one can be removed', () => {
    const a = { ...record('Alpha'), floorId: '1' }, b = { ...record('Beta'), floorId: '2' };
    const expanded = expandExhibitSelection(new Set(['Alpha', 'Beta']), { exhibits: [a, b] }, '1');
    assert.deepEqual(expanded, [{ exhibitId: 'Alpha', instanceIndex: 0 }, { exhibitId: 'Alpha', instanceIndex: 1 }]);
    const remaining = expanded.filter(entry => entry.instanceIndex !== 0);
    assert.equal(hardwareSelected('Alpha', 0, new Set(['Alpha']), remaining), false);
    assert.equal(hardwareSelected('Alpha', 1, new Set(['Alpha']), remaining), true);
});

test('the first viewport click selects the entire exhibit and the next click selects an individual component', () => {
    const a = { ...record('Alpha'), floorId: '1' }, data = { exhibits: [a] };
    const first = pickHardwareSelection(new Set(), [], data, '1', { exhibitId: 'Alpha', instanceIndex: 1, viewport: true });
    assert.deepEqual([...first.exhibits], ['Alpha']); assert.deepEqual(first.hardware, []);
    assert.equal(hardwareSelected('Alpha', 0, first.exhibits, first.hardware), true);
    const second = pickHardwareSelection(first.exhibits, first.hardware, data, '1', { exhibitId: 'Alpha', instanceIndex: 1, viewport: true });
    assert.deepEqual(second.hardware, [{ exhibitId: 'Alpha', instanceIndex: 1 }]);
});

test('manually selecting the final component becomes a whole-exhibit selection and Shift can remove one again', () => {
    const a = { ...record('Alpha'), floorId: '1' }, data = { exhibits: [a] };
    const first = pickHardwareSelection(new Set(), [], data, '1', { exhibitId: 'Alpha', instanceIndex: 0 });
    const all = pickHardwareSelection(first.exhibits, first.hardware, data, '1', { exhibitId: 'Alpha', instanceIndex: 1, extend: true });
    assert.deepEqual(all.hardware, []); assert.deepEqual([...all.exhibits], ['Alpha']);
    const subset = pickHardwareSelection(all.exhibits, all.hardware, data, '1', { exhibitId: 'Alpha', instanceIndex: 0, extend: true });
    assert.deepEqual(subset.hardware, [{ exhibitId: 'Alpha', instanceIndex: 1 }]);
    const empty = pickHardwareSelection(subset.exhibits, subset.hardware, data, '1', { exhibitId: 'Alpha', instanceIndex: 1, extend: true });
    assert.equal(empty.exhibits.size, 0); assert.deepEqual(empty.hardware, []);
});

test('Shift-clicking a new viewport exhibit selects all its hardware and preserves an existing partial selection', () => {
    const data = { exhibits: ['Alpha', 'Beta'].map(id => ({ ...record(id), floorId: '1' })) };
    const first = [{ exhibitId: 'Alpha', instanceIndex: 1 }];
    const selection = pickHardwareSelection(new Set(['Alpha']), first, data, '1', { exhibitId: 'Beta', instanceIndex: 1, viewport: true, extend: true });
    assert.deepEqual(selection.hardware, [...first, { exhibitId: 'Beta', instanceIndex: 0 }, { exhibitId: 'Beta', instanceIndex: 1 }]);
    assert.deepEqual([...selection.exhibits], ['Alpha', 'Beta']);
    assert.deepEqual(first, [{ exhibitId: 'Alpha', instanceIndex: 1 }]);
    assert.deepEqual(wholeHardwareSelection(new Set(['Alpha']), [{ exhibitId: 'Alpha', instanceIndex: 0 }], data), [{ exhibitId: 'Alpha', instanceIndex: 0 }]);
});
