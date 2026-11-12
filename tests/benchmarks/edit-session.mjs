import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { EditSession } from '../../frontend/js/domain.js';
import { editSnapshot } from '../../frontend/js/drafts.js';

// Synthetic source-data operations only; these are not browser frame or total RAM measurements.
// Run: node tests/benchmarks/edit-session.mjs [--baseline-ref 0071aff]
const args = process.argv.slice(2);
let baselineRef = '0071aff';
if (args.length === 2 && args[0] === '--baseline-ref') baselineRef = args[1];
else if (args.length === 1 && args[0].startsWith('--baseline-ref=')) baselineRef = args[0].slice(15);
else if (args.length) throw Error('Usage: node tests/benchmarks/edit-session.mjs [--baseline-ref REF]');
if (!baselineRef) throw Error('A baseline Git reference is required');

const repository = fileURLToPath(new URL('../../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trimEnd();
const baselineCommit = git(['rev-parse', '--verify', '--end-of-options', baselineRef + '^{commit}']);
const baselineDomainSource = git(['show', baselineCommit + ':frontend/js/domain.js']);
const baselineDomain = await import('data:text/javascript;base64,' + Buffer.from(baselineDomainSource).toString('base64'));
const baselineDraftSource = git(['show', baselineCommit + ':frontend/js/drafts.js']);
const baselineSnapshotBody = baselineDraftSource.match(/export function editSnapshot\(value\) \{([\s\S]*?)\n\}/)?.[1];
assert.ok(baselineSnapshotBody, 'The baseline must export editSnapshot(value)');
const baselineEditSnapshot = new Function('value', baselineSnapshotBody);

const identity = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
function fixture(count, assetCount = 10) {
    return {
        datasetKey: 'synthetic', revision: 'r', structureRevision: 's',
        floors: Array.from({ length: 16 }, (_, i) => ({
            id: String(i - 7), names: { de: 'Floor ' + i, en: 'Floor ' + i }, views: {}
        })),
        assets: Array.from({ length: assetCount }, (_, i) => ({
            id: 'HardwareModels/Synthetic-' + i + '.glb', file: 'HardwareModels/Synthetic-' + i + '.glb',
            url: 'api.php?action=asset&kind=model&id=Synthetic-' + i, kind: 'hardware', name: 'Synthetic-' + i
        })),
        exhibits: Array.from({ length: count }, (_, i) => ({
            id: 'Synthetic exhibit ' + i, name: 'Synthetic exhibit ' + i, floorId: '0', status: 'ok',
            transform: identity(), models: [{ model: 'HardwareModels/Synthetic-0.glb', transform: identity() }],
            views: {}, revision: 'r' + i, contentTag: 'c' + i, notes: [], links: []
        }))
    };
}

function medianTime(action) {
    const values = [];
    for (let i = 0; i < 5; i++) {
        const start = performance.now();
        action();
        values.push(performance.now() - start);
    }
    return values.sort((a, b) => a - b)[2];
}

const timings = [];
for (const count of [1000, 5000, 10000]) {
    const input = fixture(count);
    const previous = new baselineDomain.EditSession(input);
    const current = new EditSession(input);
    for (const session of [previous, current]) session.value.exhibits.at(-1).name += ' changed';
    assert.deepEqual(current.changes(), previous.changes(), 'Dirty-change payloads must remain identical');
    previous.changes();
    current.changes();
    const baselineMs = medianTime(() => previous.changes());
    const optimizedMs = medianTime(() => current.changes());
    timings.push({
        exhibits: count, baselineMs: +baselineMs.toFixed(2), optimizedMs: +optimizedMs.toFixed(2),
        ratio: +(baselineMs / optimizedMs).toFixed(2)
    });
}

const historyFixture = fixture(100, 3000);
const history = serialize => JSON.stringify({
    base: serialize(historyFixture), value: serialize(historyFixture),
    undoStack: Array.from({ length: 25 }, () => serialize(historyFixture)), redoStack: []
});
const baselineBytes = Buffer.byteLength(history(baselineEditSnapshot));
const optimizedBytes = Buffer.byteLength(history(editSnapshot));
console.log(JSON.stringify({
    measurement: 'Synthetic source-data operations; not browser frame time or total RAM',
    runtime: process.version, baselineRef, baselineCommit, warmupCallsPerImplementation: 2, timedIterations: 5,
    statistic: 'median', payloadEquality: 'passed', timings,
    serializedHistory: {
        exhibits: 100, assets: 3000, undoStates: 25, baselineBytes, optimizedBytes,
        reductionPercent: +(100 * (1 - optimizedBytes / baselineBytes)).toFixed(1)
    }
}, null, 2));
