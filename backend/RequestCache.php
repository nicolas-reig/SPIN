<?php

declare(strict_types=1);

final class RequestCache
{
    private const LIFETIME = 86400;
    private const MAX_BYTES = 262144;

    public function __construct(private readonly string $root)
    {
    }

    public function filename(string $request, string $fingerprint, Closure $allocate): string
    {
        $path = self::path($this->root);
        return Files::lock($path, function () use ($path, $request, $fingerprint, $allocate) {
            if (is_link($path)) throw new ApiError('invalidPath');
            $entries = is_file($path) && filesize($path) <= self::MAX_BYTES
                ? json_decode(file_get_contents($path), true) : [];
            if (!is_array($entries)) $entries = [];
            $now = time();
            $entries = array_filter($entries, fn($entry) => is_array($entry) &&
                ($entry['at'] ?? 0) >= $now - self::LIFETIME &&
                is_string($entry['filename'] ?? null) && is_string($entry['fingerprint'] ?? null));
            if (isset($entries[$request])) {
                $entry = $entries[$request];
                if ($entry['fingerprint'] !== $fingerprint) {
                    throw new ApiError('requestConflict', 409);
                }
                return $entry['filename'];
            }
            $filename = $allocate(array_column($entries, 'filename'));
            $entries[$request] = ['filename' => $filename, 'fingerprint' => $fingerprint, 'at' => $now];
            $entries = array_slice($entries, -256, null, true);
            while (strlen($body = json_encode($entries, JSON_THROW_ON_ERROR)) > self::MAX_BYTES) array_shift($entries);
            (new Files())->write($path, $body);
            chmod($path, 0600);
            return $filename;
        });
    }

    private static function path(string $root): string
    {
        return sys_get_temp_dir() . '/digitaltwin-requests-' . hash('sha256', $root) . '.json';
    }

    public static function prune(): void
    {
        foreach (glob(sys_get_temp_dir() . '/digitaltwin-requests-*.json') ?: [] as $path) {
            if (is_link($path) || filemtime($path) >= time() - self::LIFETIME) continue;
            try {
                Files::lock($path, function () use ($path) {
                    clearstatcache(true, $path);
                    if (is_file($path) && filemtime($path) < time() - self::LIFETIME) unlink($path);
                }, 0);
            } catch (ApiError) {
                continue;
            }
        }
    }
}
