<?php

declare(strict_types=1);

// Point the same synthetic tests at a frozen application source tree for regression checks.
$testSourceRoot = getenv('HUB_TEST_SOURCE_ROOT') ?: dirname(__DIR__, 2);
foreach (['Files', 'RequestCache', 'HumanFiles', 'Store', 'JoinFiles'] as $class) {
    require_once $testSourceRoot . '/backend/' . $class . '.php';
}

function testCheck(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function testError(Closure $action, string $key, int $status = 422): void
{
    try {
        $action();
    } catch (ApiError $error) {
        testCheck($error->key === $key && $error->status === $status,
            'Expected ' . $key . '/' . $status . ', received ' . $error->key . '/' . $error->status);
        return;
    }
    throw new RuntimeException('Expected ' . $key . '/' . $status . ' to be rejected');
}

function testTemp(string $name): string
{
    $path = sys_get_temp_dir() . '/digitaltwin-' . $name . '-test-' . bin2hex(random_bytes(8));
    testCheck(mkdir($path, 0775, true), 'Could not create synthetic fixture');
    return $path;
}

function testRemoveTree(string $path): void
{
    if (is_dir($path) && !is_link($path)) {
        foreach (scandir($path) ?: [] as $name) {
            if ($name !== '.' && $name !== '..') testRemoveTree($path . '/' . $name);
        }
        rmdir($path);
    } else {
        unlink($path);
    }
}

function testWrite(string $path, string $body): void
{
    if (!is_dir(dirname($path))) mkdir(dirname($path), 0775, true);
    testCheck(file_put_contents($path, $body) === strlen($body), 'Could not write synthetic fixture');
    clearstatcache(true, $path);
}

function testJson(mixed $value): string
{
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function testDecode(string $json): mixed
{
    // The fallback reproduces the original API decoder when testing the frozen baseline.
    return method_exists(Store::class, 'decodeJson') ? Store::decodeJson($json) : json_decode($json, true, 128, JSON_THROW_ON_ERROR);
}

function testIdentity(): array
{
    return ['position' => [0, 0, 0], 'rotation' => [0, 0, 0], 'scale' => [1, 1, 1]];
}

function testExhibit(array $snapshot, string $id): array
{
    foreach ($snapshot['exhibits'] as $exhibit) {
        if ($exhibit['id'] === $id) return $exhibit;
    }
    throw new RuntimeException('Missing synthetic exhibit: ' . $id);
}

function testStructure(Store $store, array $record, string $requestId): array
{
    $snapshot = $store->snapshot();
    $old = null;
    foreach ($snapshot['exhibits'] as $exhibit) {
        if ($exhibit['id'] === $record['id']) $old = $exhibit;
    }
    return $store->mutate([
        'action' => 'structure', 'requestId' => $requestId, 'signature' => 'Synthetic Tester',
        'baseRevision' => $snapshot['structureRevision'],
        'changes' => [[
            'kind' => 'exhibits', 'op' => 'put', 'id' => $record['id'],
            'baseRevision' => $old['revision'] ?? null, 'record' => $record
        ]]
    ])['snapshot'];
}
