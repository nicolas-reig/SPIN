import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateNumber, identity, normalizeViews, EditSession, structural, MapPlacement, validateViews } from '../../frontend/js/domain.js';
import { editSnapshot, restoreEditSnapshot } from '../../frontend/js/drafts.js';
import { transformNumber, vectorFields } from '../../frontend/js/edit.js';

test('six decimal rounding is symmetric, idempotent and removes negative zero', () => {
    for (const [input, expected] of [[-39.87337476309253, -39.873375], [-5.448241995756676e-7, -.000001],
        [1.2345675, 1.234568], [-1.2345675, -1.234568], [99999.9999998, 100000],
        [.00000049, 0], [-.00000049, 0], [-0, 0], [0, 0], [1, 1]]) {
        assert.equal(coordinateNumber(input), expected);
        assert.equal(coordinateNumber(coordinateNumber(input)), expected);
        assert.equal(Object.is(coordinateNumber(input), -0), false);
        assert.equal(transformNumber(input), expected);
    }
    assert.equal(coordinateNumber('1.23456789'), '1.23456789');
    assert.ok(Number.isNaN(coordinateNumber(NaN)));
    assert.equal(coordinateNumber(Infinity), Infinity);
});

test('placement inputs and inspector values use six decimals without padding', () => {
    const transform = { position: [1.23456789, -.0000004, 7], rotation: [45.123456789, 0, -1.23456789], scale: [1.00000049, .123456789, -1] };
    const placement = new MapPlacement(transform).toJSON();
    assert.deepEqual(placement, { position: [1.234568, 0, 7], rotation: [45.123457, 0, -1.234568], scale: [1, .123457, -1] });
    const html = vectorFields(transform);
    assert.match(html, /value="1\.234568"/);
    assert.match(html, /value="7"/);
    assert.doesNotMatch(html, /1\.23456789|value="-0"/);
    assert.throws(() => new MapPlacement({ ...identity(), position: [100000.0000001, 0, 0] }), /invalidTransform/);
});

test('edits, payloads, undo/redo and recovered drafts share the precision cap', () => {
    const snapshot = { floors: [], assets: [], exhibits: [{ id: 'A', name: 'A', floorId: null, status: 'ok', transform: identity(),
        models: [{ model: 'M', transform: identity() }], views: {}, notes: [], links: [] }] };
    const session = new EditSession(snapshot);
    session.change(state => {
        const record = state.exhibits[0];
        record.transform.position[0] = 12.123456789;
        record.models[0].transform.rotation[1] = -45.987654321;
        record.views['3D'] = { position: [1.123456789, 4, 2], target: [0, .123456789, 0], span: 6.123456789 };
    });
    const record = session.value.exhibits[0];
    assert.equal(record.transform.position[0], 12.123457);
    assert.equal(record.models[0].transform.rotation[1], -45.987654);
    assert.equal(record.views['3D'].span, 6.123457);
    assert.deepEqual(session.changes()[0].record, structural(record));
    const draft = editSnapshot(session.value);
    assert.equal(draft.exhibits[0].views['3D'].target[1], .123457);
    assert.deepEqual(restoreEditSnapshot(draft, snapshot).exhibits[0].transform, record.transform);
    session.undo(); assert.equal(session.value.exhibits[0].transform.position[0], 0);
    session.redo(); assert.equal(session.value.exhibits[0].transform.position[0], 12.123457);
    const steps = session.undoStack.length;
    session.change(state => { state.exhibits[0].transform.position[0] += .0000001; });
    assert.equal(session.undoStack.length, steps);
});

test('saved camera vectors and spans round together and collapsed presets remain invalid', () => {
    const views = normalizeViews({ top: { position: [1.123456789, 2, .00000149], target: [.123456789, 0, 0], span: 3.123456789 } });
    assert.deepEqual(views['2D'], { position: [1.123457, 2, .000001], target: [.123457, 0, 0], span: 3.123457 });
    assert.throws(() => validateViews(normalizeViews({ '3D': { position: [.0000001, 0, 0], target: [0, 0, 0], span: 1 } })), /invalidView/);
    assert.throws(() => validateViews(normalizeViews({ '3D': { position: [1, 0, 0], target: [0, 0, 0], span: .0000001 } })), /invalidView/);
});
