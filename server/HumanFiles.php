<?php

declare(strict_types=1);

final class HumanFiles
{
    private string $root;

    public function __construct(string $root)
    {
        if (!is_dir($root) && !mkdir($root, 0700, true)) {
            throw new ApiError('storage', 503);
        }
        $this->root = realpath($root) ?: throw new ApiError('storage', 503);
        foreach (['Exponate', 'Assets', 'Assets/Floors', 'Assets/HardwareModels'] as $name) {
            $this->directory($name);
        }
        foreach (['-1', '0', '1', '2', '_Unassigned'] as $name) {
            $this->directory('Assets/Floors/' . $name);
        }
    }

    private function path(string $relative): string
    {
        if ($relative === '' || str_contains($relative, '\\') || str_starts_with($relative, '/')) {
            throw new ApiError('invalidPath');
        }
        $path = $this->root;
        foreach (explode('/', $relative) as $part) {
            if ($part === '' || $part === '.' || $part === '..') {
                throw new ApiError('invalidPath');
            }
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
        if (!is_dir($path) && !mkdir($path, 0700, true)) {
            throw new ApiError('storage', 503);
        }
        return $path;
    }

    private function atomic(string $relative, string $body): void
    {
        $path = $this->path($relative);
        $temporary = $path . '.' . bin2hex(random_bytes(8)) . '.tmp';
        $file = fopen($temporary, 'xb');
        if (!$file) {
            throw new ApiError('storage', 503);
        }
        try {
            if (fwrite($file, $body) !== strlen($body) || !fflush($file) || !fsync($file)) {
                throw new ApiError('storage', 503);
            }
        } finally {
            fclose($file);
        }
        if (!rename($temporary, $path)) {
            @unlink($temporary);
            throw new ApiError('storage', 503);
        }
    }

    public static function filename(string $value): string
    {
        $value = trim(preg_replace('/[<>:"\/\\\\|?*\x00-\x1f]/u', '_', $value) ?? '');
        $value = rtrim($value, '. ');
        if ($value === '' || preg_match('/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu', $value)) {
            throw new ApiError('invalidInput');
        }
        return mb_strcut($value, 0, 160, 'UTF-8');
    }

    public function ensureExhibit(array &$record): void
    {
        $record['contentFolder'] ??= self::filename($record['name']);
        $base = 'Exponate/' . self::filename($record['contentFolder']);
        foreach ([$base, "$base/Notizen", "$base/Fotos", "$base/Links"] as $folder) {
            $this->directory($folder);
        }
    }

    private function base(array $record): string
    {
        return 'Exponate/' . self::filename($record['contentFolder'] ?? $record['name']);
    }

    private static function noteId(string $folder, string $filename): string
    {
        return 'n' . substr(hash('sha256', $folder . '/' . $filename), 0, 40);
    }

    private static function photoId(string $folder, string $filename): string
    {
        return 'p' . substr(hash('sha256', $folder . '/' . $filename), 0, 40);
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
            $file = $this->path($folder . '/' . $name);
            if (is_file($file)) {
                $result[$name] = $file;
            }
        }
        return $result;
    }

    private function photoName(array $record, string $id): ?string
    {
        $folder = $this->base($record) . '/Fotos';
        foreach ($this->files($folder, '') as $name => $path) {
            if (preg_match('/\.(jpe?g|png|webp)$/iu', $name) && self::photoId($folder, $name) === $id) {
                return $name;
            }
        }
        return null;
    }

    private function noteFilename(array $record, string $id): ?string
    {
        $folder = $this->base($record) . '/Notizen';
        foreach ($this->files($folder, '.md') as $name => $path) {
            if (self::noteId($folder, $name) === $id) {
                return $name;
            }
        }
        return null;
    }

    public function read(array $record): array
    {
        $base = $this->base($record);
        $notes = [];
        $links = [];
        $fingerprints = [];
        foreach ($this->files($base . '/Notizen', '.md') as $name => $path) {
            if (!preg_match('/^(.+) (\d{4}-\d{2}-\d{2})(?: (\d{2}-\d{2}-\d{2}))?(?: \[[a-f0-9]{12}\]| \(\d+\))?\.md$/u', $name, $parts)) {
                continue;
            }
            $body = file_get_contents($path);
            if ($body === false || strlen($body) > 100000) {
                continue;
            }
            $time = $parts[2] . ' ' . ($parts[3] ?? '12-00-00');
            $when = DateTimeImmutable::createFromFormat('!Y-m-d H-i-s', $time, new DateTimeZone('Europe/Berlin'));
            if (!$when || $when->format('Y-m-d H-i-s') !== $time) {
                continue;
            }
            $fingerprints[] = $name . ':' . hash('sha256', $body);
            $fileHash = hash('sha256', $body);
            $id = self::noteId($base . '/Notizen', $name);
            $note = [
                'id' => $id,
                'author' => $parts[1],
                'at' => $when->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
                'body' => trim($body),
                'fileHash' => $fileHash,
                'images' => [],
                'corrections' => []
            ];
            if (preg_match('/^deleted by (.+)$/iu', trim($body), $deleted)) {
                $note['deleted'] = ['signature' => trim($deleted[1]), 'at' => gmdate('Y-m-d\TH:i:s\Z', filemtime($path) ?: time())];
            }
            $notes[] = $note;
        }
        usort($notes, fn($a, $b) => strcmp($b['at'], $a['at']) ?: strcmp($b['id'], $a['id']));
        foreach ($this->files($base . '/Links', '.url') as $name => $path) {
            $title = substr($name, 0, -4);
            $contents = file_get_contents($path);
            if ($contents === false || strlen($contents) > 5000) {
                continue;
            }
            if (str_starts_with($contents, "\xff\xfe")) {
                $contents = iconv('UTF-16LE', 'UTF-8', substr($contents, 2)) ?: '';
            } elseif (str_starts_with($contents, "\xef\xbb\xbf")) {
                $contents = substr($contents, 3);
            }
            if (!preg_match('/^\[InternetShortcut\]\r?\n/m', $contents) || !preg_match('/^URL=(.+)\r?$/m', $contents, $match)) {
                continue;
            }
            try {
                $url = Store::url(trim($match[1]));
            } catch (ApiError) {
                continue;
            }
            $fingerprints[] = $name . ':' . hash('sha256', $contents);
            preg_match('/^Comment=(.*)\r?$/m', $contents, $comment);
            $links[] = ['id' => 'l' . substr(hash('sha256', $base . '/Links/' . $name), 0, 40), 'title' => $title, 'url' => $url, 'description' => $comment[1] ?? ''];
        }
        usort($links, fn($a, $b) => strcasecmp($a['title'], $b['title']));
        sort($fingerprints);
        return ['notes' => $notes, 'links' => $links, 'contentTag' => hash('sha256', implode("\n", $fingerprints))];
    }

    public function saveNote(array $record, string $action, array $note, string $signature): void
    {
        $folder = $this->base($record) . '/Notizen';
        $body = $action === 'deleteNote' ? 'deleted by ' . $signature . "\n" : rtrim($note['body']);
        if ($action !== 'deleteNote') {
            foreach ($note['images'] as $image) {
                $photo = $this->photoName($record, $image) ?? throw new ApiError('invalidImage');
                $body .= "\n\n![Foto](../Fotos/" . rawurlencode($photo) . ')';
            }
            $body .= "\n";
        }
        if ($action === 'note') {
            $suffix = substr(hash('sha256', $note['id']), 0, 12);
            foreach ($this->files($folder, '.md') as $existing => $path) {
                if (str_ends_with($existing, ' [' . $suffix . '].md')) {
                    if (file_get_contents($path) !== $body) {
                        throw new ApiError('requestConflict', 409);
                    }
                    return;
                }
            }
            $stamp = (new DateTimeImmutable('now', new DateTimeZone('Europe/Berlin')))->format('Y-m-d H-i-s');
            $name = self::filename($signature) . ' ' . $stamp . ' [' . $suffix . '].md';
        } else {
            $name = $this->noteFilename($record, $note['id']) ?? throw new ApiError('notFound', 404);
            $currentHash = hash_file('sha256', $this->path($folder . '/' . $name));
            if (($note['fileHash'] ?? null) !== $currentHash) {
                throw new ApiError('conflict', 409);
            }
        }
        $this->atomic($folder . '/' . $name, $body);
    }

    public function putLink(array $record, ?string $id, string $title, string $url, string $description): void
    {
        $folder = $this->base($record) . '/Links';
        $filenameTitle = self::filename($title);
        if ($filenameTitle !== trim($title)) {
            throw new ApiError('invalidTitle');
        }
        $title = $filenameTitle;
        $old = $id === null ? null : $this->linkFilename($record, $id);
        if ($id !== null && $old === null) {
            throw new ApiError('notFound', 404);
        }
        $name = $title . '.url';
        foreach ($this->files($folder, '.url') as $other => $path) {
            if (mb_strtolower($other) === mb_strtolower($name) && $other !== $old) {
                throw new ApiError('duplicateTitle', 409);
            }
        }
        if ($old !== null && $old !== $name && mb_strtolower($old) === mb_strtolower($name)) {
            if (!rename($this->path($folder . '/' . $old), $this->path($folder . '/' . $name))) {
                throw new ApiError('storage', 503);
            }
            $old = $name;
        }
        $contents = "[InternetShortcut]\r\nURL=" . Store::url($url) . "\r\n";
        if ($description !== '') {
            $contents .= 'Comment=' . str_replace(["\r", "\n"], ' ', $description) . "\r\n";
        }
        $this->atomic($folder . '/' . $name, $contents);
        if ($old !== null && $old !== $name) {
            unlink($this->path($folder . '/' . $old));
        }
    }

    private function linkFilename(array $record, string $id): ?string
    {
        $folder = $this->base($record) . '/Links';
        foreach ($this->files($folder, '.url') as $name => $path) {
            if ('l' . substr(hash('sha256', $folder . '/' . $name), 0, 40) === $id) {
                return $name;
            }
        }
        return null;
    }

    public function deleteLink(array $record, string $id): void
    {
        $name = $this->linkFilename($record, $id) ?? throw new ApiError('notFound', 404);
        if (!unlink($this->path($this->base($record) . '/Links/' . $name))) {
            throw new ApiError('storage', 503);
        }
    }

    public function savePhoto(array $record, string $signature, string $bytes, string $mime): array
    {
        $extension = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime] ?? throw new ApiError('invalidImage');
        $folder = $this->base($record) . '/Fotos';
        $stem = self::filename($signature) . ' ' . (new DateTimeImmutable('now', new DateTimeZone('Europe/Berlin')))->format('Y-m-d H-i-s');
        $name = $stem . '.' . $extension;
        for ($number = 2; file_exists($this->path($folder . '/' . $name)); $number++) {
            $name = $stem . ' (' . $number . ').' . $extension;
        }
        $this->atomic($folder . '/' . $name, $bytes);
        return ['id' => self::photoId($folder, $name), 'name' => $name];
    }

    public function photo(string $id): array
    {
        foreach (scandir($this->path('Exponate')) ?: [] as $folderName) {
            if ($folderName[0] === '.' || !is_dir($this->path('Exponate/' . $folderName))) {
                continue;
            }
            $folder = 'Exponate/' . $folderName . '/Fotos';
            foreach ($this->files($folder, '') as $name => $path) {
                if (self::photoId($folder, $name) === $id && preg_match('/\.(jpe?g|png|webp)$/iu', $name)) {
                    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);
                    if (in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
                        return ['path' => $path, 'mime' => $mime];
                    }
                }
            }
        }
        throw new ApiError('notFound', 404);
    }

    public function namedPhoto(array $record, string $name): array
    {
        if ($name === '' || basename($name) !== $name || !preg_match('/\.(jpe?g|png|webp)$/iu', $name)) {
            throw new ApiError('invalidPath');
        }
        $path = $this->path($this->base($record) . '/Fotos/' . $name);
        if (!is_file($path)) {
            throw new ApiError('notFound', 404);
        }
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path);
        if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
            throw new ApiError('invalidImage');
        }
        return ['path' => $path, 'mime' => $mime];
    }

    public function model(string $file): array
    {
        if (!str_starts_with($file, 'Assets/Floors/') && !str_starts_with($file, 'Assets/HardwareModels/')) {
            throw new ApiError('invalidPath');
        }
        $path = $this->path($file);
        if (!is_file($path) || !str_ends_with($path, '.glb')) {
            throw new ApiError('notFound', 404);
        }
        return ['path' => $path, 'mime' => 'model/gltf-binary'];
    }

    public function saveModel(string $id, string $name, string $bytes): string
    {
        $file = 'Assets/HardwareModels/' . self::filename(pathinfo($name, PATHINFO_FILENAME)) . ' [' . $id . '].glb';
        $this->atomic($file, $bytes);
        return $file;
    }
}
