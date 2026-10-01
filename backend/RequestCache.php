<?php

declare(strict_types=1);

final class RequestCache
{
    public function __construct(private readonly string $root)
    {
    }

    public function filename(string $request, string $fingerprint, Closure $allocate): string
    {
        if (!function_exists('shm_attach') || !function_exists('sem_get')) {
            throw new ApiError('storage', 503);
        }
        $lockKey = (crc32("filename-lock\n" . $this->root) & 0x7fffffff) ?: 1;
        $memoryKey = (crc32("filename-cache\n" . $this->root) & 0x7fffffff) ?: 1;
        $lock = sem_get($lockKey, 1, 0660, true);
        if (!$lock || !sem_acquire($lock)) {
            throw new ApiError('busy', 409);
        }
        $memory = null;
        try {
            $memory = shm_attach($memoryKey, 2 * 1024 * 1024, 0660);
            if (!$memory) {
                throw new ApiError('storage', 503);
            }
            $entries = shm_has_var($memory, 1) ? shm_get_var($memory, 1) : [];
            if (!is_array($entries)) {
                throw new ApiError('storage', 503);
            }
            $now = time();
            $entries = array_filter($entries, fn($entry) => $entry['at'] >= $now - 86400);
            $prefix = $this->root . "\0";
            $request = $prefix . $request;
            if (isset($entries[$request])) {
                $entry = $entries[$request];
                if ($entry['fingerprint'] !== $fingerprint) {
                    throw new ApiError('requestConflict', 409);
                }
                return $entry['filename'];
            }
            $reserved = array_filter($entries, fn($entry, $key) => str_starts_with($key, $prefix), ARRAY_FILTER_USE_BOTH);
            $filename = $allocate(array_column($reserved, 'filename'));
            $entries[$request] = ['filename' => $filename, 'fingerprint' => $fingerprint, 'at' => $now];
            $entries = array_slice($entries, -1024, null, true);
            if (!shm_put_var($memory, 1, $entries)) {
                throw new ApiError('storage', 503);
            }
            return $filename;
        } finally {
            if ($memory) {
                shm_detach($memory);
            }
            sem_release($lock);
        }
    }
}
