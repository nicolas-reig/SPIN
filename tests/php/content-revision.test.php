<?php

declare(strict_types=1);

require __DIR__ . '/source-fixtures.php';

$root = testTemp('content-revision');
try {
    $assets = $root . '/Assets';
    $exhibits = $root . '/Exhibits';
    mkdir($assets, 0775, true);
    mkdir($exhibits . '/Synthetic/Notizen', 0775, true);
    $names = [
        'plain' => 'Tester 01_01_2026 10.00.md',
        'edited' => 'Tester 01_01_2026 10.01.md',
        'deleted' => 'Tester 01_01_2026 10.02.md'
    ];
    $bodies = [
        'plain' => "Synthetic body\n",
        'edited' => "Synthetic correction\n\n<!-- edited by Prüfer Ω -->\n",
        'deleted' => "deleted by Prüfer Ω\n"
    ];
    $initialTime = 1700000000;
    foreach ($names as $kind => $name) {
        testWrite($exhibits . '/Synthetic/Notizen/' . $name, $bodies[$kind]);
        touch($exhibits . '/Synthetic/Notizen/' . $name, $initialTime);
    }
    clearstatcache();
    $store = new Store($assets, $exhibits);
    $initial = $store->snapshot();
    $initialRecord = testExhibit($initial, 'Synthetic');
    foreach (['edited', 'deleted'] as $index => $kind) {
        $path = $exhibits . '/Synthetic/Notizen/' . $names[$kind];
        $mtime = $initialTime + ($index + 1) * 60;
        testCheck(touch($path, $mtime), 'Could not update synthetic attribution date');
        clearstatcache(true, $path);
        $updated = $store->snapshot();
        $record = testExhibit($updated, 'Synthetic');
        $note = current(array_filter($record['notes'], fn($note) => $note['file'] === $names[$kind]));
        $attribution = $kind === 'edited' ? $note['corrections'][0] : $note['deleted'];
        testCheck($attribution['at'] === gmdate('Y-m-d\TH:i:s\Z', $mtime), 'Displayed attribution must use the file modification time');
        testCheck($record['contentTag'] !== $initialRecord['contentTag'], 'Mtime-only ' . $kind . ' attribution changes must invalidate contentTag');
        testCheck($updated['revision'] !== $initial['revision'], 'Mtime-only ' . $kind . ' changes must refresh snapshots');
        testCheck($updated['structureRevision'] === $initial['structureRevision'] && $record['revision'] === $initialRecord['revision'], 'Attribution date changes must not become structural conflicts');
        testCheck($note['fileHash'] === hash('sha256', $bodies[$kind]), 'An attribution date change must not alter the optimistic body hash');
        touch($path, $initialTime);
        clearstatcache(true, $path);
        testCheck($store->snapshot()['revision'] === $initial['revision'], 'Restoring attribution must restore its derived revision');
    }
    $plain = $exhibits . '/Synthetic/Notizen/' . $names['plain'];
    touch($plain, $initialTime + 600);
    clearstatcache(true, $plain);
    testCheck($store->snapshot()['revision'] === $initial['revision'], 'Touching a post without displayed edit/deletion attribution must not change its content');

    $edited = $exhibits . '/Synthetic/Notizen/' . $names['edited'];
    touch($edited, 0);
    clearstatcache(true, $edited);
    $epoch = testExhibit($store->snapshot(), 'Synthetic');
    $note = current(array_filter($epoch['notes'], fn($note) => $note['file'] === $names['edited']));
    testCheck($note['corrections'][0]['at'] === '1970-01-01T00:00:00Z', 'A valid zero mtime must retain the Unix epoch');

    unlink($edited);
    clearstatcache(true, $edited);
    $removed = $store->snapshot();
    testCheck(count(testExhibit($removed, 'Synthetic')['notes']) === 2 && $removed['revision'] !== $initial['revision'], 'Physically removing a post must refresh the snapshot');
    echo "Content attribution and revision contracts passed\n";
} finally {
    testRemoveTree($root);
}
