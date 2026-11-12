<?php

declare(strict_types=1);

require_once __DIR__ . '/../../backend/Files.php';
require_once __DIR__ . '/../../backend/RequestCache.php';
require_once __DIR__ . '/../../backend/HumanFiles.php';
require_once __DIR__ . '/../../backend/Store.php';

function check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function removeFixture(string $path): void
{
    foreach (scandir($path) ?: [] as $name) {
        if ($name === '.' || $name === '..') continue;
        $entry = $path . '/' . $name;
        if (is_dir($entry)) removeFixture($entry);
        else unlink($entry);
    }
    rmdir($path);
}

$root = sys_get_temp_dir() . '/digitaltwin-human-files-test-' . bin2hex(random_bytes(8));
mkdir($root . '/Synthetic/Notizen', 0775, true);
mkdir($root . '/Synthetic/Links', 0775, true);
try {
    $note = str_repeat('n', 100000);
    file_put_contents($root . '/Synthetic/Notizen/Tester 01_01_2026 10.00.md', $note);
    file_put_contents($root . '/Synthetic/Notizen/Tester 01_01_2026 10.01.md', $note . 'x');
    $link = "[InternetShortcut]\r\nURL=https://example.org/manual\r\nComment=";
    $link .= str_repeat('d', 5000 - strlen($link));
    file_put_contents($root . '/Synthetic/Links/Boundary.url', $link);
    file_put_contents($root . '/Synthetic/Links/Oversized.url', $link . 'x');
    $reader = new HumanFiles($root, new Files());
    $result = $reader->read('Synthetic');
    check(count($result['notes']) === 1, 'Only the note at the byte limit should be accepted');
    check($result['notes'][0]['body'] === $note, 'A note at the limit must remain intact');
    check($result['notes'][0]['fileHash'] === hash('sha256', $note), 'Accepted note hashes must use the full body');
    check(count($result['links']) === 1 && $result['links'][0]['title'] === 'Boundary', 'Only the shortcut at the byte limit should be accepted');
    $tag = $result['contentTag'];

    // Sparse synthetic files exceed the PHP memory limit if they are read in full.
    foreach (['Notizen/Tester 01_01_2026 10.02.md', 'Links/Huge.url'] as $relative) {
        $file = fopen($root . '/Synthetic/' . $relative, 'wb');
        check($file !== false && ftruncate($file, 128 * 1024 * 1024), 'Could not create sparse test input');
        fclose($file);
    }
    ini_set('memory_limit', '32M');
    $result = $reader->read('Synthetic');
    check(count($result['notes']) === 1 && count($result['links']) === 1, 'Oversized sparse files must be skipped');
    check($result['contentTag'] === $tag, 'Skipped files must not change valid content tags');
    echo "HumanFiles bounded reads passed\n";
} finally {
    removeFixture($root);
}
