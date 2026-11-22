<?php

declare(strict_types=1);

require __DIR__ . '/source-fixtures.php';

$root = testTemp('saved-view-contract');
try {
    $assets = $root . '/Library';
    $exhibits = $root . '/Contents';
    mkdir($assets . '/Floors/4', 0775, true);
    mkdir($exhibits . '/Synthetic', 0775, true);
    $floorPath = $assets . '/Floors/.floors.json';
    $metaPath = $exhibits . '/Synthetic/.exhibit.json';
    $store = new Store($assets, $exhibits);
    $view = fn(string $position = '[0,4,0.01]', string $target = '[0,0,0]', string $span = '2') =>
        '{"position":' . $position . ',"target":' . $target . ',"span":' . $span . '}';
    $valid = $view();
    $invalid = [
        'numeric string component' => $view('[0,"4",0.01]'),
        'xyz position object' => $view('{"x":0,"y":4,"z":0.01}'),
        'numeric-key position object' => $view('{"0":0,"1":4,"2":0.01}'),
        'numeric-key target object' => $view('[0,4,0.01]', '{"0":0,"1":0,"2":0}'),
        'short target' => $view('[0,4,0.01]', '[0,0]'),
        'out-of-bounds component' => $view('[0,100000.001,0.01]'),
        'identical position and target' => $view('[0,0,0]'),
        'string span' => $view('[0,4,0.01]', '[0,0,0]', '"2"'),
        'boolean span' => $view('[0,4,0.01]', '[0,0,0]', 'true'),
        'object span' => $view('[0,4,0.01]', '[0,0,0]', '{"value":2}'),
        'zero span' => $view('[0,4,0.01]', '[0,0,0]', '0'),
        'negative span' => $view('[0,4,0.01]', '[0,0,0]', '-1'),
        'out-of-bounds span' => $view('[0,4,0.01]', '[0,0,0]', '100000.001')
    ];
    foreach ($invalid as $case => $json) {
        $views = '{"2D":' . $json . ',"top":' . $valid . ',"three":' . $valid . '}';
        $floorRaw = '{"4":{"de":"Test Ω","en":"Test Ω","views":' . $views . '}}';
        testWrite($floorPath, $floorRaw);
        $metaRaw = '{"views":' . $views . '}';
        testWrite($metaPath, $metaRaw);
        $snapshot = $store->snapshot();
        foreach ([$snapshot['floors'][0]['views'], testExhibit($snapshot, 'Synthetic')['views']] as $readViews) {
            $readViews = (array)$readViews;
            testCheck(array_keys($readViews) === ['3D'], 'Only the invalid individual preset must be ignored, with the explicit new key taking precedence: ' . $case);
            testCheck($readViews['3D']['span'] === 2.0 && $readViews['3D']['position'] === [0.0, 4.0, 0.01], 'Valid legacy presets must retain their normalized values');
        }
        testError(fn() => testStructure($store, [
            'id' => 'Synthetic', 'name' => 'Synthetic', 'floorId' => '4', 'models' => [],
            'views' => testDecode('{"2D":' . $json . '}')
        ], 'invalid_view_' . array_search($case, array_keys($invalid))), 'invalidView');
        testCheck(file_get_contents($metaPath) === $metaRaw && file_get_contents($floorPath) === $floorRaw, 'Rejected views must not rewrite exhibit or floor metadata');
    }
    $boundary = ['position' => [-100000, 100000, 0], 'target' => [100000, -100000, 0], 'span' => 100000];
    $snapshot = testStructure($store, [
        'id' => 'Synthetic', 'name' => 'Synthetic', 'floorId' => '4', 'models' => [],
        'views' => ['top' => $boundary + ['mode' => 'obsolete'], 'three' => $boundary]
    ], 'valid_view_boundary_001');
    $readViews = (array)testExhibit($snapshot, 'Synthetic')['views'];
    testCheck(array_keys($readViews) === ['2D', '3D'] && $readViews['2D'] == $boundary, 'Inclusive boundaries and legacy keys must round-trip through signed saves');
    $stored = json_decode(file_get_contents($metaPath), true, 128, JSON_THROW_ON_ERROR);
    testCheck(array_keys($stored['views']) === ['2D', '3D'] && !isset($stored['views']['2D']['mode']), 'New saves must use current keys and omit the obsolete mode');
    $snapshot = testStructure($store, ['id' => 'Synthetic', 'name' => 'Synthetic', 'models' => [], 'views' => []], 'automatic_view_001');
    testCheck((array)testExhibit($snapshot, 'Synthetic')['views'] === [], 'Empty view maps must keep automatic framing');
    $hardware = 'HardwareModels/Focus.glb';
    mkdir($assets . '/HardwareModels');
    testWrite($assets . '/' . $hardware, 'synthetic model file');
    $record = [
        'id' => 'Synthetic', 'name' => 'Synthetic', 'floorId' => '4',
        'models' => [['model' => $hardware, 'transform' => [
            'position' => [0, 0, 0], 'rotation' => [0, 0, 0], 'scale' => [1, 1, 1]
        ]]], 'views' => ['3D' => $boundary]
    ];
    $persist = function (array $record, string $requestId, array $focusDirections = []) use ($store) {
        $before = $store->snapshot();
        $exhibit = testExhibit($before, $record['id']);
        $result = $store->mutate([
            'action' => 'structure', 'signature' => 'Synthetic editor',
            'baseRevision' => $before['structureRevision'], 'requestId' => $requestId, 'focusDirections' => $focusDirections,
            'changes' => [['kind' => 'exhibits', 'op' => 'put', 'id' => $record['id'], 'baseRevision' => $exhibit['revision'], 'record' => $record]]
        ]);
        return testExhibit($result['snapshot'], $record['name']);
    };
    $direction = [.123456789, .6, -.8];
    $saved = $persist($record, 'focus_direction_001', ['Synthetic' => $direction]);
    testCheck($saved['focusDirection'] === [.123457, .6, -.8], 'Signed saves persist the rounded generated direction');
    testCheck(((array)$saved['views'])['3D'] == $boundary, 'Automatic focus leaves manually saved views intact');
    $record['name'] = 'Renamed';
    $saved = $persist($record, 'focus_direction_002');
    testCheck($saved['focusDirection'] === [.123457, .6, -.8], 'A rename preserves the existing direction');
    $renamedPath = $exhibits . '/Renamed/.exhibit.json';
    $meta = json_decode(file_get_contents($renamedPath), true, 128, JSON_THROW_ON_ERROR);
    $edited = $meta;
    $edited['models'][0]['transform']['rotation'][1] = 45;
    testWrite($renamedPath, json_encode($edited, JSON_THROW_ON_ERROR));
    testCheck(testExhibit($store->snapshot(), 'Renamed')['focusDirection'] === null, 'An external component edit invalidates the cached direction');
    testWrite($renamedPath, json_encode($meta, JSON_THROW_ON_ERROR));
    testWrite($assets . '/' . $hardware, 'replacement model with a different size');
    clearstatcache();
    testCheck(testExhibit($store->snapshot(), 'Renamed')['focusDirection'] === null, 'A replaced model invalidates the direction');
    echo "Saved-view and automatic-focus contracts passed\n";
} finally {
    testRemoveTree($root);
}
