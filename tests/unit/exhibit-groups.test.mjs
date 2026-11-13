import test from 'node:test';
import assert from 'node:assert/strict';
import { exhibitGroup, exhibitGroupKey, groupExhibits, ExhibitGroupState } from '../../frontend/js/exhibit-groups.js';

const record = name => ({ id: name, name });

test('groups use the first hyphen while names without a complete prefix remain ungrouped', () => {
    for (const [name, expected] of [['Pic-Station 5', 'Pic'], ['Pic-Station-Left', 'Pic'],
        ['Mini-AR', 'Mini'], ['Station 5', ''], ['-Station', ''], ['Pic-', ''], ['Pic-  ', ''], ['Pic - Station 5', 'Pic']]) {
        assert.equal(exhibitGroup(name), expected);
    }
    assert.equal(exhibitGroupKey('PÍC-Station'), exhibitGroupKey('pi\u0301c-Other'));
});

test('grouped sections keep full names, references and IDs intact, with natural ordering and ungrouped rows last', () => {
    const records = ['Pic-Station 10', 'Station 1', 'Mini-HLW', 'Pic-Station 2', 'mini-AR'].map(record);
    const before = structuredClone(records);
    const groups = groupExhibits(records);
    assert.deepEqual(groups.map(group => group.key), ['mini', 'pic', '']);
    assert.deepEqual(groups[0].records.map(record => record.name), ['mini-AR', 'Mini-HLW']);
    assert.deepEqual(groups[1].records.map(record => record.name), ['Pic-Station 2', 'Pic-Station 10']);
    assert.equal(groups[1].records[0], records[3]);
    assert.deepEqual(records, before);
    assert.deepEqual(groupExhibits([]), []);
    assert.equal(groupExhibits([record('__proto__-Display')])[0].key, '__proto__');
});

test('search can reveal matching groups temporarily without changing the collapse preference', () => {
    const state = new ExhibitGroupState();
    state.setOpen('pic', false);
    assert.equal(state.isOpen('pic'), false);
    assert.equal(state.isOpen('pic', true), true);
    assert.equal(state.isOpen('pic'), false);
    state.setOpen('pic', true); assert.equal(state.isOpen('pic'), true);
});

test('new viewport selections reveal their group while ordinary renders and existing selections keep manually folded groups closed', () => {
    const state = new ExhibitGroupState(), pic = record('Pic-Station 2'), mini = record('Mini-AR');
    state.reveal([pic]); state.setOpen('pic', false);
    state.reveal([pic]); assert.equal(state.isOpen('pic'), false);
    state.setOpen('mini', false); state.reveal([pic, mini]);
    assert.equal(state.isOpen('pic'), false); assert.equal(state.isOpen('mini'), true);
    state.reveal([record('Pic-Station 3')]); assert.equal(state.isOpen('pic'), true);
    state.setOpen('new', false);
    state.reveal([{ ...pic, name: 'New-Station 2' }]); assert.equal(state.isOpen('new'), true);
});
