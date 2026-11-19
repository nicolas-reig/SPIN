<?php

declare(strict_types=1);

require __DIR__ . '/source-fixtures.php';

$root = testTemp('batch-content');
try {
    $exhibits = $root . '/Exhibits';
    mkdir($exhibits . '/North', 0775, true);
    mkdir($exhibits . '/Unselected');
    testWrite($exhibits . '/South/.exhibit.json', testJson(['status' => 'problem']));
    $store = new Store($root . '/Assets', $exhibits);
    $targets = fn(array $snapshot) => array_map(function (string $id) use ($snapshot) {
        $record = testExhibit($snapshot, $id);
        return ['exhibitId' => $id, 'baseRevision' => $record['revision'], 'contentTag' => $record['contentTag']];
    }, ['North', 'South']);
    $initial = $store->snapshot();
    $post = [
        'action' => 'note', 'requestId' => 'batch-post-test', 'targets' => $targets($initial),
        'signature' => 'Synthetic Tester', 'body' => '**Checked** both exhibits.'
    ];
    $photo = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=', true);
    $uploads = [['requestId' => 'batch-photo-test', 'bytes' => $photo, 'mime' => 'image/png']];

    $missing = $post;
    $missing['targets'][1]['exhibitId'] = 'Missing';
    testError(fn() => $store->mutate($missing, $uploads), 'notFound', 404);
    testCheck(!is_dir($exhibits . '/North/Notizen') && !is_dir($exhibits . '/North/Fotos'), 'Failed post batches roll back earlier posts and photos');
    $duplicate = $post;
    $duplicate['targets'][1] = $duplicate['targets'][0];
    testError(fn() => $store->mutate($duplicate, $uploads), 'invalidInput');

    $posted = $store->mutate($post, $uploads)['snapshot'];
    foreach (['North', 'South'] as $id) {
        $notes = testExhibit($posted, $id)['notes'];
        testCheck(count($notes) === 1 && $notes[0]['author'] === 'Synthetic Tester', 'Each recipient gets a signed copy');
        testCheck(str_starts_with($notes[0]['body'], $post['body']), 'The Markdown body is retained');
        preg_match('~\(\.\./Fotos/([^)]*)\)~', $notes[0]['body'], $match);
        testCheck(isset($match[1]), 'The post references an exhibit-relative photo');
        $asset = $store->namedPhoto($id, rawurldecode($match[1]));
        testCheck(file_get_contents($asset['path']) === $photo, 'Each recipient has its own photo');
        testCheck(testExhibit($posted, $id)['status'] === testExhibit($initial, $id)['status'], 'Batch posts preserve service status');
    }
    $post['targets'] = array_reverse($post['targets']);
    testCheck($store->mutate($post, $uploads)['snapshot']['revision'] === $posted['revision'], 'An identical retry creates no more posts or photos');
    $post['body'] = 'Different post';
    testError(fn() => $store->mutate($post, $uploads), 'requestConflict', 409);

    $link = ['action' => 'putLink', 'requestId' => 'batch-link-test', 'targets' => $targets($posted),
        'title' => 'Shared manual', 'url' => 'example.org/manual', 'description' => 'Maintenance guide'];
    $existing = $exhibits . '/South/Links/Shared manual.url';
    testWrite($existing, "[InternetShortcut]\r\nURL=https://example.org/existing\r\n");
    testError(fn() => $store->mutate($link), 'conflict', 409);
    testCheck(!is_dir($exhibits . '/North/Links'), 'A stale recipient rolls back earlier links');
    $link['targets'] = $targets($store->snapshot());
    try {
        $store->mutate($link);
        throw new RuntimeException('A duplicate title should reject the batch');
    } catch (ApiError $error) {
        testCheck($error->key === 'duplicateTitle' && $error->details['exhibitId'] === 'South', 'A duplicate identifies the conflicting recipient');
    }
    testCheck(!is_dir($exhibits . '/North/Links'), 'A duplicate title rolls back earlier links');
    unlink($existing);
    $link['targets'] = $targets($store->snapshot());
    $linked = $store->mutate($link)['snapshot'];
    testCheck($store->mutate($link)['snapshot']['revision'] === $linked['revision'], 'A retry succeeds with the original revisions');
    foreach (['North', 'South'] as $id) {
        $links = testExhibit($linked, $id)['links'];
        testCheck(count($links) === 1 && $links[0]['url'] === 'http://example.org/manual' &&
            $links[0]['description'] === $link['description'], 'Each recipient gets the documentation shortcut');
    }
    $unselected = testExhibit($linked, 'Unselected');
    testCheck(!$unselected['notes'] && !$unselected['links'], 'Writes are limited to the selected exhibits');
    echo "Batch posts and documentation links passed\n";
} finally {
    testRemoveTree($root);
}
