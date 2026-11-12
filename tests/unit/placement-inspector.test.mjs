import test from 'node:test';
import assert from 'node:assert/strict';
import { identity } from '../../frontend/js/domain.js';
import { hardwareParameters, exhibitParameters } from '../../frontend/js/placement-inspector.js';

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
