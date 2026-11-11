<?php

declare(strict_types=1);

final class Files
{
    private bool $active = false;
    private array $undo = [];
    private array $detached = [];

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
            $result = $action();
        } catch (Throwable $error) {
            $this->active = false;
            try {
                foreach (array_reverse($this->undo) as $step) {
                    [$kind, $path] = $step;
                    if ($kind === 'move') $this->move($path, $step[2]);
                    elseif ($kind === 'directory') $this->directory($path);
                    elseif ($kind === 'remove') $this->remove($path);
                    elseif ($step[2] === null) $this->remove($path);
                    else {
                        $this->write($path, $step[2]);
                        if ($step[3] && (!chmod($path, $step[3]['mode'] & 0777) ||
                            !touch($path, $step[3]['mtime'], $step[3]['atime']))) throw new ApiError('storage', 503);
                    }
                }
            } catch (Throwable $rollback) {
                error_log('File rollback failed: ' . $rollback->getMessage());
                throw new ApiError('storage', 503);
            }
            throw $error;
        } finally {
            $this->active = false;
            $detached = $this->detached;
            $this->undo = [];
            $this->detached = [];
        }
        foreach ($detached as [, $temporary]) {
            try {
                self::eraseTree($temporary);
            } catch (Throwable $error) {
                error_log('Deleted exhibit cleanup failed: ' . $error->getMessage());
            }
        }
        return $result;
    }

    public function directory(string $path): void
    {
        if (is_link($path)) throw new ApiError('invalidPath');
        if (is_dir($path)) return;
        $parent = dirname($path);
        if ($parent !== $path) $this->directory($parent);
        if (!mkdir($path, 0775)) throw new ApiError('storage', 503);
        if ($this->active) $this->undo[] = ['remove', $path];
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
        $before = $this->active ? $this->previous($path) : null;
        $stat = $this->active && is_file($path) ? stat($path) : null;
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
            if ($this->active) $this->undo[] = ['write', $path, $before, $stat];
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
            if ($this->active) $this->undo[] = ['directory', $path];
        } elseif (is_file($path)) {
            $before = $this->active ? $this->previous($path) : null;
            $stat = $this->active ? stat($path) : null;
            if (!unlink($path)) throw new ApiError('storage', 503);
            if ($this->active) $this->undo[] = ['write', $path, $before, $stat];
        }
    }

    private static function treePaths(string $path): iterable
    {
        if (is_dir($path) && !is_link($path)) {
            $entries = scandir($path);
            if ($entries === false) throw new ApiError('storage', 503);
            foreach ($entries as $name) {
                if ($name !== '.' && $name !== '..') yield from self::treePaths($path . '/' . $name);
            }
        }
        yield $path;
    }

    private static function eraseTree(string $path): void
    {
        foreach (self::treePaths($path) as $entry) {
            $removed = is_dir($entry) && !is_link($entry) ? rmdir($entry) : unlink($entry);
            if (!$removed) throw new ApiError('storage', 503);
        }
    }

    public function removeTree(string $path): void
    {
        if (is_link($path)) throw new ApiError('invalidPath');
        foreach (self::treePaths($path) as $entry) {
            if (!is_writable(dirname($entry))) throw new ApiError('storage', 503);
        }
        if (!$this->active) {
            self::eraseTree($path);
            return;
        }
        // Move the whole folder so a failed save can restore its contents without copying photos.
        $temporary = dirname($path) . '/.delete-' . bin2hex(random_bytes(16));
        $this->move($path, $temporary);
        $this->detached[] = [$path, $temporary];
    }

    public function move(string $source, string $destination): void
    {
        if (is_link($source) || is_link($destination)) throw new ApiError('invalidPath');
        clearstatcache(true, $destination);
        if (file_exists($destination)) throw new ApiError('duplicateName', 409);
        if (!rename($source, $destination)) throw new ApiError('storage', 503);
        if ($this->active) $this->undo[] = ['move', $destination, $source];
    }
}
