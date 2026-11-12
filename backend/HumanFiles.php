<?php

declare(strict_types=1);

final class HumanFiles
{
    private RequestCache $requests;

    public function __construct(private readonly string $root, private readonly Files $files)
    {
        if (!is_dir($root) || is_link($root)) {
            throw new ApiError('storage', 503);
        }
        $this->requests = new RequestCache(realpath($root) ?: $root);
    }

    public static function filename(string $value): string
    {
        if (
            $value === '' || $value !== trim($value) || strlen($value) > 160 || str_starts_with($value, '.') ||
            preg_match('//u', $value) !== 1 ||
            preg_match('/[<>:"\/\\\\|?*\x00-\x1f\x7f]/u', $value) ||
            preg_match('/[. ]$/u', $value) ||
            preg_match('/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu', $value)
        ) {
            throw new ApiError('invalidInput');
        }
        return $value;
    }

    private function path(string $relative): string
    {
        $path = $this->root;
        foreach (explode('/', $relative) as $part) {
            self::filename($part);
            $path .= '/' . $part;
            if (is_link($path)) {
                throw new ApiError('invalidPath');
            }
        }
        return $path;
    }

    private function directory(string $relative): string
    {
        $path = $this->path($relative);
        $this->files->directory($path);
        return $path;
    }

    private function write(string $relative, string $body, bool $new = false): void
    {
        $path = $this->path($relative);
        $this->files->write($path, $body, $new);
    }

    private function files(string $folder, string $extension): array
    {
        $path = $this->path($folder);
        if (!is_dir($path)) {
            return [];
        }
        $result = [];
        foreach (scandir($path) ?: [] as $name) {
            if ($name[0] === '.' || !str_ends_with(mb_strtolower($name), $extension)) {
                continue;
            }
            try {
                $file = $this->path($folder . '/' . $name);
                if (is_file($file)) {
                    $result[$name] = $file;
                }
            } catch (ApiError) {
                continue;
            }
        }
        return $result;
    }

    private static function noteId(string $folder, string $name): string
    {
        return 'n' . substr(hash('sha256', $folder . '/' . $name), 0, 40);
    }

    private static function photoId(string $folder, string $name): string
    {
        return 'p' . substr(hash('sha256', $folder . '/' . $name), 0, 40);
    }

    private static function modifiedAt(string $path): string
    {
        $mtime = filemtime($path);
        return gmdate('Y-m-d\TH:i:s\Z', $mtime === false ? time() : $mtime);
    }

    public static function datedFilename(string $name): ?array
    {
        if (!preg_match('/^(.+) (\d{2}_\d{2}_\d{4}|\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})(?: (\d{2}\.\d{2}(?:\.\d{2})?|\d{2}-\d{2}-\d{2}))?(?: \[[a-f0-9]{12}\]| \(\d+\))?\.(md|jpe?g|png|webp)$/iu', $name, $parts)) {
            return null;
        }
        $format = str_contains($parts[2], '_') ? 'd_m_Y' : (preg_match('/^\d{4}-/', $parts[2]) ? 'Y-m-d' : 'd-m-Y');
        $time = $parts[3] !== '' ? str_replace('.', '-', $parts[3]) : '12-00-00';
        if (strlen($time) === 5) {
            $time .= '-00';
        }
        $value = $parts[2] . ' ' . $time;
        $when = DateTimeImmutable::createFromFormat('!' . $format . ' H-i-s', $value, new DateTimeZone('Europe/Berlin'));
        if (!$when || $when->format($format . ' H-i-s') !== $value) {
            return null;
        }
        return ['author' => $parts[1], 'when' => $when, 'extension' => strtolower($parts[4])];
    }

    private function availableFilename(string $folder, string $signature, string $extension, array $reserved, DateTimeImmutable $when): string
    {
        $used = [];
        foreach (array_keys($this->files($folder, '')) as $name) {
            $used[mb_strtolower($name)] = true;
            $dated = self::datedFilename($name);
            if ($dated && $dated['extension'] === $extension) {
                $used[mb_strtolower($dated['author'] . ' ' . $dated['when']->format('d_m_Y H.i') . '.' . $extension)] = true;
            }
        }
        foreach ($reserved as $relative) {
            if (dirname($relative) === $folder) {
                $used[mb_strtolower(basename($relative))] = true;
            }
        }
        do {
            $name = self::filename($signature . ' ' . $when->format('d_m_Y H.i') . '.' . $extension);
            $when = $when->modify('+1 minute');
        } while (isset($used[mb_strtolower($name)]));
        return $name;
    }

    private function newFile(string $folder, string $signature, string $extension, string $body, string $requestId): string
    {
        $this->directory($folder);
        $fingerprint = hash('sha256', $signature . "\0" . $extension . "\0" . $body);
        $relative = $this->requests->filename($folder . '/' . $requestId, $fingerprint, function ($reserved) use ($folder, $signature, $extension, $requestId) {
            $suffix = substr(hash('sha256', $requestId), 0, 12);
            foreach (array_keys($this->files($folder, '')) as $name) {
                if (str_ends_with($name, ' [' . $suffix . '].' . $extension)) {
                    return $folder . '/' . $name;
                }
            }
            return $folder . '/' . $this->availableFilename($folder, $signature, $extension, $reserved, new DateTimeImmutable('now', new DateTimeZone('Europe/Berlin')));
        });
        $path = $this->path($relative);
        if (file_exists($path)) {
            if (!is_file($path) || hash_file('sha256', $path) !== hash('sha256', $body)) {
                throw new ApiError('requestConflict', 409);
            }
        } else {
            $this->write($relative, $body, true);
        }
        return basename($relative);
    }

    public function read(string $exhibit): array
    {
        self::filename($exhibit);
        $notes = [];
        $links = [];
        $fingerprints = [];
        $noteFolder = $exhibit . '/Notizen';
        foreach ($this->files($noteFolder, '.md') as $name => $path) {
            $dated = self::datedFilename($name);
            if (!$dated) {
                continue;
            }
            $body = file_get_contents($path, false, null, 0, 100001);
            if ($body === false || strlen($body) > 100000) {
                continue;
            }
            $note = [
                'id' => self::noteId($noteFolder, $name),
                'file' => $name,
                'author' => $dated['author'],
                'at' => $dated['when']->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
                'body' => trim($body),
                'fileHash' => hash('sha256', $body),
                'images' => [],
                'corrections' => []
            ];
            if (preg_match('/\n<!-- edited by ([^\r\n<>]+) -->\s*$/u', $note['body'], $edited)) {
                $note['body'] = trim(substr($note['body'], 0, -strlen($edited[0])));
                $note['corrections'][] = [
                    'signature' => trim($edited[1]),
                    'at' => self::modifiedAt($path)
                ];
            }
            if (preg_match('/^deleted by (.+)$/iu', $note['body'], $deleted)) {
                $note['deleted'] = [
                    'signature' => trim($deleted[1]),
                    'at' => self::modifiedAt($path)
                ];
            }
            $attributionAt = $note['deleted']['at'] ?? ($note['corrections'][0]['at'] ?? null);
            $fingerprints[] = $name . ':' . $note['fileHash'] . ($attributionAt === null ? '' : ':' . $attributionAt);
            $notes[] = $note;
        }
        usort($notes, fn($a, $b) => strcmp($b['at'], $a['at']) ?: strcmp($b['id'], $a['id']));
        $linkFolder = $exhibit . '/Links';
        foreach ($this->files($linkFolder, '.url') as $name => $path) {
            $body = file_get_contents($path, false, null, 0, 5001);
            if ($body === false || strlen($body) > 5000) {
                continue;
            }
            if (str_starts_with($body, "\xff\xfe")) {
                $body = iconv('UTF-16LE', 'UTF-8', substr($body, 2)) ?: '';
            } elseif (str_starts_with($body, "\xef\xbb\xbf")) {
                $body = substr($body, 3);
            }
            if (!preg_match('/^\[InternetShortcut\]\r?$/m', $body) || !preg_match('/^URL=(.+)\r?$/m', $body, $match)) {
                continue;
            }
            try {
                $url = Store::url(trim($match[1]));
            } catch (ApiError) {
                continue;
            }
            preg_match('/^Comment=([^\r\n]*)\r?$/m', $body, $comment);
            $fingerprints[] = $name . ':' . hash('sha256', $body);
            $links[] = [
                'id' => 'l' . substr(hash('sha256', $linkFolder . '/' . $name), 0, 40),
                'title' => substr($name, 0, -4),
                'url' => $url,
                'description' => $comment[1] ?? ''
            ];
        }
        usort($links, fn($a, $b) => strcasecmp($a['title'], $b['title']));
        sort($fingerprints);
        return ['notes' => $notes, 'links' => $links, 'contentTag' => hash('sha256', implode("\n", $fingerprints))];
    }

    private function findNote(string $exhibit, string $id): ?string
    {
        $folder = $exhibit . '/Notizen';
        foreach ($this->files($folder, '.md') as $name => $path) {
            if (self::noteId($folder, $name) === $id) {
                return $name;
            }
        }
        return null;
    }

    private function findPhoto(string $exhibit, string $id): ?string
    {
        $folder = $exhibit . '/Fotos';
        foreach ($this->files($folder, '') as $name => $path) {
            if (preg_match('/\.(jpe?g|png|webp)$/iu', $name) && self::photoId($folder, $name) === $id) {
                return $name;
            }
        }
        return null;
    }

    public function saveNote(string $exhibit, string $action, array $note, string $signature, string $requestId): void
    {
        $folder = $exhibit . '/Notizen';
        $this->directory($folder);
        $body = $action === 'deleteNote' ? 'deleted by ' . $signature . "\n" : rtrim($note['body']);
        if ($action !== 'deleteNote') {
            foreach ($note['images'] as $image) {
                $photo = $this->findPhoto($exhibit, $image) ?? throw new ApiError('invalidImage');
                $body .= "\n\n![Foto](../Fotos/" . rawurlencode($photo) . ')';
            }
            if ($action === 'correctNote') {
                $body .= "\n\n<!-- edited by " . str_replace(['<', '>', "\n"], '', $signature) . ' -->';
            }
            $body .= "\n";
        }
        if ($action === 'note') {
            $this->newFile($folder, $signature, 'md', $body, $requestId);
            return;
        }
        $name = $this->findNote($exhibit, $note['id']) ?? throw new ApiError('notFound', 404);
        if (hash_file('sha256', $this->path($folder . '/' . $name)) !== ($note['fileHash'] ?? null)) {
            throw new ApiError('conflict', 409);
        }
        $this->write($folder . '/' . $name, $body);
    }

    private function findLink(string $exhibit, string $id): ?string
    {
        $folder = $exhibit . '/Links';
        foreach ($this->files($folder, '.url') as $name => $path) {
            if ('l' . substr(hash('sha256', $folder . '/' . $name), 0, 40) === $id) {
                return $name;
            }
        }
        return null;
    }

    public function putLink(string $exhibit, ?string $id, string $title, string $url, string $description): void
    {
        $title = self::filename($title);
        $folder = $exhibit . '/Links';
        $this->directory($folder);
        $old = $id === null ? null : $this->findLink($exhibit, $id);
        if ($id !== null && $old === null) {
            throw new ApiError('notFound', 404);
        }
        $name = $title . '.url';
        foreach ($this->files($folder, '.url') as $other => $path) {
            if (mb_strtolower($other) === mb_strtolower($name) && $other !== $old) {
                throw new ApiError('duplicateTitle', 409);
            }
        }
        $body = "[InternetShortcut]\r\nURL=" . Store::url($url) . "\r\n";
        if ($description !== '') {
            $body .= 'Comment=' . str_replace(["\r", "\n"], ' ', $description) . "\r\n";
        }
        $source = $old !== null ? stat($this->path($folder . '/' . $old)) : false;
        $target = @stat($this->path($folder . '/' . $name));
        $sameFile = $source && $target && $source['dev'] === $target['dev'] && $source['ino'] === $target['ino'];
        if ($old !== $name && $sameFile) {
            if (!is_writable($this->path($folder . '/' . $old))) throw new ApiError('storage', 503);
            $this->files->remove($this->path($folder . '/' . $old));
        }
        $this->write($folder . '/' . $name, $body, $old !== $name);
        if ($old !== null && $old !== $name && !$sameFile) {
            $this->files->remove($this->path($folder . '/' . $old));
        }
    }

    public function deleteLink(string $exhibit, string $id): void
    {
        $name = $this->findLink($exhibit, $id) ?? throw new ApiError('notFound', 404);
        $this->files->remove($this->path($exhibit . '/Links/' . $name));
    }

    public function savePhoto(string $exhibit, string $signature, string $requestId, string $bytes, string $mime): array
    {
        $extension = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime] ?? throw new ApiError('invalidImage');
        $folder = $exhibit . '/Fotos';
        $name = $this->newFile($folder, $signature, $extension, $bytes, $requestId);
        return ['id' => self::photoId($folder, $name), 'name' => $name];
    }

    public function photo(string $id): array
    {
        foreach (scandir($this->root) ?: [] as $exhibit) {
            if ($exhibit[0] === '.' || !is_dir($this->root . '/' . $exhibit) || is_link($this->root . '/' . $exhibit)) {
                continue;
            }
            $name = $this->findPhoto($exhibit, $id);
            if ($name !== null) {
                return $this->namedPhoto($exhibit, $name);
            }
        }
        throw new ApiError('notFound', 404);
    }

    public function namedPhoto(string $exhibit, string $name): array
    {
        self::filename($exhibit);
        self::filename($name);
        if (!preg_match('/\.(jpe?g|png|webp)$/iu', $name)) {
            throw new ApiError('invalidPath');
        }
        $path = $this->path($exhibit . '/Fotos/' . $name);
        if (!is_file($path)) {
            throw new ApiError('notFound', 404);
        }
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);
        if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
            throw new ApiError('invalidImage');
        }
        return ['path' => $path, 'mime' => $mime];
    }
}
