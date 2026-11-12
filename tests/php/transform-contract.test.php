<?php

declare(strict_types=1);

require __DIR__ . '/source-fixtures.php';

$root = testTemp('transform-contract');
try {
    $assets = $root . '/Library';
    $exhibits = $root . '/Contents';
    $id = 'Prüfstück Ω';
    $model = 'HardwareModels/Modell 🧪.glb';
    foreach (['-7', '4', '12', '-0', '04', '+4', '4.0', ' 4', (string)PHP_INT_MAX . '0'] as $floor) {
        mkdir($assets . '/Floors/' . $floor, 0775, true);
    }
    testWrite($assets . '/Floors/4/model.glb', 'synthetic floor bytes');
    testWrite($assets . '/' . $model, 'synthetic hardware bytes');
    testWrite($assets . '/Floors/.floors.json', testJson([
        '-7' => ['de' => 'Untergeschoss Ω', 'en' => ''],
        '4' => 'Fourth Ω', '12' => ['de' => '   ', 'en' => 'Upper floor']
    ]));
    mkdir($exhibits . '/' . $id, 0775, true);
    $metaPath = $exhibits . '/' . $id . '/.exhibit.json';
    $store = new Store($assets, $exhibits);
    $snapshot = $store->snapshot();
    testCheck(array_column($snapshot['floors'], 'id') === ['-7', '4', '12'], 'Only canonical, representable integer floor directories must be discovered and numerically sorted');
    testCheck(array_column($snapshot['floors'], 'order') === [-7, 4, 12], 'Negative and nonzero floor IDs must keep their numeric order');
    testCheck($snapshot['floors'][0]['names'] === ['de' => 'Untergeschoss Ω', 'en' => '-7'], 'Missing bilingual names must fall back per language');
    testCheck($snapshot['floors'][1]['names'] === ['de' => 'Fourth Ω', 'en' => 'Fourth Ω'], 'Legacy string floor-name entries must remain supported');
    testCheck($snapshot['floors'][2]['modelId'] === null && $snapshot['floors'][2]['names']['de'] === '12', 'Floors must be discovered without models and without a floor zero');

    foreach (['{}', '[]', '[{"de":"Array entry"}]', '{"-7":{"de":"Unten","en":"Below"},"4":"Four","empty":{},"list":[{"de":"Nested"}]}'] as $json) {
        testCheck(testDecode($json) === json_decode($json, true, 128, JSON_THROW_ON_ERROR), 'Normal object maps, arrays and empty metadata must keep their prior interfaces');
    }
    testCheck(testDecode('null') === null, 'Top-level scalar decoding must remain unchanged');
    try {
        testDecode('{');
        throw new RuntimeException('Malformed JSON must be rejected');
    } catch (JsonException) {
        // The API retains its existing invalidInput handling for malformed JSON.
    }

    $transform = fn(string $position = '[1,2,3]', string $rotation = '[0,0,0]', string $scale = '[1,1,1]') =>
        '{"position":' . $position . ',"rotation":' . $rotation . ',"scale":' . $scale . '}';
    $invalid = [
        'numeric string' => $transform('["1",2,3]'),
        'xyz object' => $transform('{"x":1,"y":2,"z":3}'),
        'numeric-key object' => $transform('{"0":1,"1":2,"2":3}'),
        'sparse object' => $transform('{"0":1,"2":2,"3":3}'),
        'short vector' => $transform('[1,2]'),
        'long vector' => $transform('[1,2,3,4]'),
        'boolean component' => $transform('[true,2,3]'),
        'null component' => $transform('[null,2,3]'),
        'position upper bound' => $transform('[100000.001,2,3]'),
        'rotation lower bound' => $transform('[1,2,3]', '[0,-100000.001,0]'),
        'scale lower bound' => $transform('[1,2,3]', '[0,0,0]', '[-1000.001,1,1]'),
        'scale upper bound' => $transform('[1,2,3]', '[0,0,0]', '[1000.001,1,1]'),
        'missing array' => '{"position":[1,2,3],"rotation":[0,0,0]}'
    ];
    foreach ($invalid as $case => $json) {
        $raw = '{"floor":4,"transform":' . $json . ',"models":[{"model":' . testJson($model) . ',"transform":' . $json . '},{"model":' . testJson($model) . '},{"model":"HardwareModels/Missing.glb"}]}';
        testWrite($metaPath, $raw);
        $record = testExhibit($store->snapshot(), $id);
        testCheck($record['transform'] === testIdentity(), 'Invalid shared transform must fall back to identity: ' . $case);
        testCheck(count($record['models']) === 1 && $record['models'][0]['transform'] == testIdentity(), 'Invalid instances must be skipped while a missing instance transform uses identity: ' . $case);
        testCheck($record['floorId'] === '4' && $record['placed'], 'Valid nonzero placement must survive rejected neighboring model instances');

        $input = ['id' => $id, 'name' => $id, 'floorId' => '4', 'transform' => testDecode($json), 'models' => []];
        testError(fn() => testStructure($store, $input, 'bad_shared_' . array_search($case, array_keys($invalid))), 'invalidTransform');
        $input['transform'] = testIdentity();
        $input['models'] = [['model' => $model, 'transform' => testDecode($json)]];
        testError(fn() => testStructure($store, $input, 'bad_instance_' . array_search($case, array_keys($invalid))), 'invalidTransform');
        testCheck(file_get_contents($metaPath) === $raw, 'Rejected structural input must not rewrite metadata');
    }

    $overflow = $transform('[1e999,2,3]');
    testWrite($metaPath, '{"floor":4,"transform":' . $overflow . ',"models":[{"model":' . testJson($model) . ',"transform":' . $overflow . '}]}');
    $record = testExhibit($store->snapshot(), $id);
    testCheck($record['transform'] === testIdentity() && !$record['models'] && !$record['placed'], 'Nonfinite decoded numbers must be rejected when reading');

    $boundary = ['position' => [-100000, 100000, 0], 'rotation' => [100000, -100000, 0], 'scale' => [0.001, 1000, 1]];
    $saved = testStructure($store, [
        'id' => $id, 'name' => $id, 'floorId' => '-7', 'transform' => $boundary,
        'models' => [['model' => $model, 'transform' => $boundary]], 'status' => 'problem'
    ], 'valid_boundary_001');
    $record = testExhibit($saved, $id);
    testCheck($record['transform'] == $boundary && $record['models'][0]['transform'] == $boundary && $record['floorId'] === '-7', 'Inclusive numeric boundaries and negative floor assignments must round-trip through signed saves');
    $stored = json_decode(file_get_contents($metaPath), true, 128, JSON_THROW_ON_ERROR);
    testCheck($stored['floor'] === -7 && $stored['lastEditedBy'] === 'Synthetic Tester', 'Saves must retain the documented integer floor representation and signature');
    foreach ([[-1, 0, 1], [0, 0, 0], [-1000, .00001, 1000]] as $index => $scale) {
        $signed = ['position' => [1, 2, 3], 'rotation' => [0, 45, 0], 'scale' => $scale];
        $saved = testStructure($store, [
            'id' => $id, 'name' => $id, 'floorId' => '4', 'transform' => $signed,
            'models' => [['model' => $model, 'transform' => $signed]]
        ], 'signed_zero_scale_' . $index);
        $record = testExhibit($store->snapshot(), $id);
        testCheck($record['transform'] == $signed && $record['models'][0]['transform'] == $signed,
            'Signed, zero and small scale components must survive signed save and reload');
    }
    testWrite($metaPath, 'null');
    testError(fn() => $store->snapshot(), 'invalidMetadata', 503);
    echo "Transform, JSON shape and floor contracts passed\n";
} finally {
    testRemoveTree($root);
}
