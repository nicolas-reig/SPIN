<?php

declare(strict_types=1);

require __DIR__ . '/source-fixtures.php';

$root = testTemp('filename-contract');
try {
    foreach (['Prüfstück Ω 🧪', 'اسم عربي', 'नमूना', 'CONSOLE', 'A . B', str_repeat('A', 160), str_repeat('é', 80)] as $name) {
        testCheck(HumanFiles::filename($name) === $name, 'Valid UTF-8 filenames must retain their exact bytes');
    }
    foreach (['', ' Leading', 'Trailing ', '.hidden', 'Ending.', 'CON', 'nul.txt', 'COM1.glb', 'LPT9',
        'A/B', 'A\\B', 'A:B', 'A?B', "A\tB", "A\x7fB", "Invalid\xc3\x28", str_repeat('é', 80) . 'x'] as $name) {
        testError(fn() => HumanFiles::filename($name), 'invalidInput');
    }
    testCheck(Store::signature('  Synthetic Tester  ') === 'Synthetic Tester', 'User signature normalization must remain supported');
    testCheck(Store::text('  Manual Ω  ') === 'Manual Ω', 'User text normalization must remain separate from path validation');

    $assets = $root . '/Library';
    $exhibits = $root . '/Contents';
    mkdir($assets . '/HardwareModels', 0775, true);
    mkdir($exhibits . '/Prüfstück Ω 🧪/Notizen', 0775, true);
    mkdir($exhibits . '/Prüfstück Ω 🧪/Links', 0775, true);
    mkdir($exhibits . '/ Leading exhibit');
    mkdir($exhibits . '/Trailing exhibit ');
    testWrite($assets . '/HardwareModels/Library Ω.glb', 'synthetic model bytes');
    testWrite($assets . '/HardwareModels/ Hidden.glb', 'synthetic model bytes');
    testWrite($assets . '/HardwareModels/Trailing.glb ', 'synthetic model bytes');
    testWrite($exhibits . '/Prüfstück Ω 🧪/Notizen/Tester 01_01_2026 10.00.md', 'Synthetic Unicode body: Grüße مرحبا नमस्ते 🧪');
    testWrite($exhibits . '/Prüfstück Ω 🧪/Notizen/ Hidden 01_01_2026 10.01.md', 'must not be discovered');
    testWrite($exhibits . '/Prüfstück Ω 🧪/Links/Manual Ω.url', "[InternetShortcut]\r\nURL=https://example.org/manual\r\n");
    testWrite($exhibits . '/Prüfstück Ω 🧪/Links/ Hidden.url', "[InternetShortcut]\r\nURL=https://example.org/ignored\r\n");

    $store = new Store($assets, $exhibits);
    $snapshot = $store->snapshot();
    testCheck(array_column($snapshot['exhibits'], 'id') === ['Prüfstück Ω 🧪'], 'Noncanonical exhibit names must be skipped without aliasing a valid name');
    testCheck(array_column($snapshot['assets'], 'id') === ['HardwareModels/Library Ω.glb'], 'Noncanonical hardware filenames must be skipped');
    $record = $snapshot['exhibits'][0];
    testCheck(count($record['notes']) === 1 && $record['notes'][0]['author'] === 'Tester', 'Noncanonical post filenames must be skipped');
    testCheck(count($record['links']) === 1 && $record['links'][0]['title'] === 'Manual Ω', 'Noncanonical shortcut filenames must be skipped');
    testCheck(str_contains($record['notes'][0]['body'], 'مرحبا नमस्ते 🧪'), 'Unicode post content must be retained');
    testCheck(json_decode(testJson($snapshot), true, 128, JSON_THROW_ON_ERROR)['exhibits'][0]['id'] === $record['id'], 'Unicode snapshots must remain JSON serializable');
    testError(fn() => (new HumanFiles($exhibits, new Files()))->read(' Leading exhibit'), 'invalidInput');
    testError(fn() => $store->asset('model', 'HardwareModels/ Hidden.glb'), 'notFound', 404);
    testError(fn() => $store->namedPhoto('Prüfstück Ω 🧪', ' Missing.png'), 'invalidInput');

    $result = $store->mutate([
        'action' => 'putLink', 'requestId' => 'filename_link_001', 'exhibitId' => $record['id'],
        'baseRevision' => $record['revision'], 'contentTag' => $record['contentTag'],
        'title' => '  Normalized Ω  ', 'url' => 'https://example.org/normalized'
    ]);
    testCheck(is_file($exhibits . '/Prüfstück Ω 🧪/Links/Normalized Ω.url'), 'App link titles must retain deliberate input trimming');
    testCheck(count(testExhibit($result['snapshot'], $record['id'])['links']) === 2, 'A normalized app-created shortcut must be discoverable');
    echo "Filename canonicality and Unicode contracts passed\n";
} finally {
    testRemoveTree($root);
}
