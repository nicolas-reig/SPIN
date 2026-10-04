<?php

declare(strict_types=1);

final class Files
{
    private bool $active = false;
    private array $before = [];
    private array $created = [];
    private array $removed = [];

    public static function lock(string $key, Closure $action, float $timeout = 10): mixed
    {
        $path = sys_get_temp_dir() . '/digitaltwin-lock-' . hash('sha256', $key) . '.lock';
        $deadline = microtime(true) + $timeout;
        while (true) {
            if (is_link($path)) throw new ApiError('invalidPath');
            $file = @fopen($path, 'c+b');
            if (!$file) throw new ApiError('storage', 503);
            while (!flock($file, LOCK_EX | LOCK_NB)) {
                if (microtime(true) >= $deadline) {
                    fclose($file);
                    throw new ApiError('busy', 409);
                }
                usleep(10000);
            }
            clearstatcache(true, $path);
            $opened = fstat($file);
            $current = @lstat($path);
            if ($current && $opened['ino'] === $current['ino'] && $opened['dev'] === $current['dev']) break;
            flock($file, LOCK_UN);
            fclose($file);
            if (microtime(true) >= $deadline) throw new ApiError('busy', 409);
        }
        chmod($path, 0600);
        try {
            return $action();
        } finally {
            unlink($path);
            flock($file, LOCK_UN);
            fclose($file);
        }
    }

    public function transaction(Closure $action): mixed
    {
        if ($this->active) return $action();
        $this->active = true;
        try {
            return $action();
        } catch (Throwable $error) {
            $this->active = false;
            try {
                foreach (array_reverse($this->removed) as $path) $this->directory($path);
                foreach (array_reverse($this->before, true) as $path => $body) {
                    if ($body === null) {
                        if (is_file($path) && !unlink($path)) throw new ApiError('storage', 503);
                    } else {
                        $this->write($path, $body);
                    }
                }
                foreach (array_reverse($this->created) as $path) {
                    if (is_dir($path) && !rmdir($path)) throw new ApiError('storage', 503);
                }
            } catch (Throwable $rollback) {
                error_log('File rollback failed: ' . $rollback->getMessage());
                throw new ApiError('storage', 503);
            }
            throw $error;
        } finally {
            $this->active = false;
            $this->before = $this->created = $this->removed = [];
        }
    }

    public function directory(string $path): void
    {
        if (is_link($path)) throw new ApiError('invalidPath');
        if (is_dir($path)) return;
        $parent = dirname($path);
        if ($parent !== $path) $this->directory($parent);
        if (!mkdir($path, 0775)) throw new ApiError('storage', 503);
        if ($this->active) $this->created[] = $path;
    }

    private function previous(string $path): ?string
    {
        $body = is_file($path) ? file_get_contents($path) : null;
        if ($body === false) throw new ApiError('storage', 503);
        return $body;
    }

    public function write(string $path, string $body, bool $new = false): void
    {
        if (is_link($path)) throw new ApiError('invalidPath');
        if ($new && file_exists($path)) throw new ApiError('conflict', 409);
        if (is_file($path) && !is_writable($path)) throw new ApiError('storage', 503);
        $remember = $this->active && !array_key_exists($path, $this->before);
        $before = $remember ? $this->previous($path) : null;
        $temporary = dirname($path) . '/.' . basename($path) . '.' . bin2hex(random_bytes(8)) . '.tmp';
        $file = @fopen($temporary, 'xb');
        if (!$file) throw new ApiError('storage', 503);
        try {
            if (fwrite($file, $body) !== strlen($body) || !fflush($file) || !fsync($file)) {
                throw new ApiError('storage', 503);
            }
            fclose($file);
            $file = null;
            if (is_file($path)) chmod($temporary, fileperms($path) & 0777);
            if (!rename($temporary, $path)) throw new ApiError('storage', 503);
            if ($remember) $this->before[$path] = $before;
        } finally {
            if (is_resource($file)) fclose($file);
            if (is_file($temporary)) unlink($temporary);
        }
    }

    public function remove(string $path): void
    {
        if (is_link($path)) throw new ApiError('invalidPath');
        if (is_dir($path)) {
            if (!rmdir($path)) throw new ApiError('storage', 503);
            if ($this->active) $this->removed[] = $path;
        } elseif (is_file($path)) {
            $remember = $this->active && !array_key_exists($path, $this->before);
            $before = $remember ? $this->previous($path) : null;
            if (!unlink($path)) throw new ApiError('storage', 503);
            if ($remember) $this->before[$path] = $before;
        }
    }
}
