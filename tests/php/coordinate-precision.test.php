<?php

declare(strict_types=1);
require __DIR__ . '/source-fixtures.php';

$root = testTemp('coordinate-precision');
try {
    $assets = $root . '/Assets';
    $exhibits = $root . '/Exponate';
    testWrite($assets . '/Floors/4/model.glb', 'synthetic floor');
    testWrite($assets . '/HardwareModels/Test.glb', 'synthetic model');
    $path = $exhibits . '/A/.exhibit.json';
    $rawTransform = ['position' => [-39.87337476309253, -5.448241995756676e-7, .00000049],
        'rotation' => [-1.2345675, 1.2345675, 0], 'scale' => [1.123456789, -1.123456789, .0000004]];
    $expectedTransform = ['position' => [-39.873375, -.000001, 0], 'rotation' => [-1.234568, 1.234568, 0], 'scale' => [1.123457, -1.123457, 0]];
    $rawView = ['position' => [1.123456789, 4, 2], 'target' => [.123456789, 0, 0], 'span' => 6.123456789];
    $expectedView = ['position' => [1.123457, 4, 2], 'target' => [.123457, 0, 0], 'span' => 6.123457];
    $record = ['floor' => 4, 'transform' => $rawTransform, 'models' => [['model' => 'HardwareModels/Test.glb', 'transform' => $rawTransform]], 'views' => ['3D' => $rawView]];
    $raw = testJson($record);
    testWrite($path, $raw);
    testWrite($assets . '/Floors/.floors.json', testJson(['4' => ['views' => ['2D' => $rawView]]]));
    $store = new Store($assets, $exhibits);
    $snapshot = $store->snapshot();
    $read = testExhibit($snapshot, 'A');
    testCheck($read['transform'] == $expectedTransform && $read['models'][0]['transform'] == $expectedTransform, 'API reads must cap every transform vector at six decimals');
    testCheck(((array)$read['views'])['3D'] == $expectedView && ((array)$snapshot['floors'][0]['views'])['2D'] == $expectedView, 'Floor and exhibit saved cameras must use the same cap');
    testCheck(file_get_contents($path) === $raw, 'Reading precision must not rewrite source metadata');
    $saved = testStructure($store, ['id' => 'A', 'name' => 'A', 'floorId' => '4', 'transform' => $rawTransform,
        'models' => $record['models'], 'views' => ['3D' => $rawView]], 'precision_save_001');
    $stored = json_decode(file_get_contents($path), true, 128, JSON_THROW_ON_ERROR);
    testCheck($stored['transform'] == $expectedTransform && $stored['models'][0]['transform'] == $expectedTransform && $stored['views']['3D'] == $expectedView, 'Signed saves must store canonical coordinates, rotations, scales and cameras');
    testCheck($stored['lastEditedBy'] === 'Synthetic Tester', 'Precision normalization must retain signatures');
    foreach ([['position' => [.0000001, 0, 0], 'target' => [0, 0, 0], 'span' => 1],
        ['position' => [1, 0, 0], 'target' => [0, 0, 0], 'span' => .0000001]] as $index => $invalid) {
        testError(fn() => testStructure($store, ['id' => 'A', 'name' => 'A', 'models' => [], 'views' => ['3D' => $invalid]], 'collapsed_precision_' . $index), 'invalidView');
    }
    echo "Six-decimal coordinate reads and signed-save contracts passed\n";
} finally {
    testRemoveTree($root);
}
