<?php

declare(strict_types=1);

final class ApiError extends RuntimeException
{
    public function __construct(
        public readonly string $key,
        public readonly int $status = 422,
        public readonly array $details = []
    ) {
        parent::__construct($key);
    }
}

final class Store
{
    private string $assets;
    private string $exhibits;
    private HumanFiles $human;
    private Files $files;
    private bool $locked = false;

    public function __construct(string $assets, string $exhibits)
    {
        foreach ([$assets, $exhibits] as $root) {
            if (!is_dir($root) && !mkdir($root, 0775, true)) {
                throw new ApiError('storage', 503);
            }
            if (is_link($root)) {
                throw new ApiError('invalidPath');
            }
        }
        $this->assets = realpath($assets) ?: throw new ApiError('storage', 503);
        $this->exhibits = realpath($exhibits) ?: throw new ApiError('storage', 503);
        $webapp = realpath(dirname(__DIR__));
        foreach ([$this->assets, $this->exhibits] as $root) {
            if ($root === $webapp || str_starts_with($root, $webapp . '/')) {
                throw new ApiError('invalidPath');
            }
        }
        $this->files = new Files();
        $this->human = new HumanFiles($this->exhibits, $this->files);
    }

    public static function text(mixed $value, int $max = 200, bool $required = true): string
    {
        if (!is_string($value) || strlen($value) > $max || ($required && trim($value) === '')) {
            throw new ApiError('invalidInput');
        }
        return trim($value);
    }

    public static function signature(mixed $value): string
    {
        if (!is_string($value) || trim($value) === '') {
            throw new ApiError('signatureRequired');
        }
        $signature = self::text($value, 120);
        HumanFiles::filename($signature);
        return $signature;
    }

    public static function url(mixed $value): string
    {
        $url = self::text($value, 2048);
        $hasScheme = preg_match('/^[a-z][a-z0-9+.-]*:/i', $url) === 1;
        $hostWithPort = !str_contains($url, '://') && preg_match('~^[^/?#:]+\.[^/?#:]*:\d*(?:[/?#]|$)~', $url) === 1;
        if (!$hasScheme || $hostWithPort) {
            $url = self::httpUrl($url);
        }
        if (!preg_match('/^([a-z][a-z0-9+.-]*):/i', $url, $match) || preg_match('/[\x00-\x20\x7f]/', $url)) {
            throw new ApiError('invalidUrl');
        }
        $scheme = strtolower($match[1]);
        if (in_array($scheme, ['javascript', 'vbscript', 'data', 'blob', 'filesystem'], true)) {
            throw new ApiError('invalidUrl');
        }
        $target = substr($url, strlen($match[0]));
        $hasAuthority = preg_match('~^//([^/?#]*)~', $target, $authority) === 1;
        $network = in_array($scheme, ['http', 'https', 'smb', 'ftp'], true);
        if (($network && (!$hasAuthority || $authority[1] === '')) || ($scheme === 'file' && $target === '')) {
            throw new ApiError('invalidUrl');
        }
        if ($hasAuthority && (str_contains($authority[1], '@') ||
            ($authority[1] !== '' && parse_url($url) === false))) {
            throw new ApiError('invalidUrl');
        }
        return $url;
    }

    private static function httpUrl(string $value): string
    {
        if (preg_match('/[\s\\\\\x00-\x20\x7f]/u', $value) ||
            !preg_match('~^(\[[^\]]+\]|[^/?#:]+)(?::([0-9]+))?([/?#].*)?$~D', $value, $parts) ||
            (isset($parts[2]) && $parts[2] !== '' && (strlen($parts[2]) > 5 || (int)$parts[2] > 65535))) {
            throw new ApiError('invalidUrl');
        }
        $host = $parts[1];
        if (str_starts_with($host, '[')) {
            $valid = filter_var(substr($host, 1, -1), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false;
        } elseif (preg_match('/^[0-9.]+$/D', $host)) {
            $valid = filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
        } else {
            $domain = preg_replace('/\.$/D', '', $host);
            if (preg_match('/[^\x00-\x7f]/', $domain)) {
                $domain = function_exists('idn_to_ascii') ? idn_to_ascii($domain, IDNA_USE_STD3_RULES, INTL_IDNA_VARIANT_UTS46) : false;
            }
            $labels = $domain === false ? [] : explode('.', $domain);
            $valid = count($labels) >= 2 && strlen($domain ?: '') <= 253 &&
                !preg_match('/^(?:[0-9]+|0x[0-9a-f]*)$/iD', end($labels) ?: '') &&
                !array_filter($labels, fn($label) => preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iD', $label) !== 1);
        }
        if (!$valid || strlen($value) + 7 > 2048) {
            throw new ApiError('invalidUrl');
        }
        return 'http://' . $value;
    }

    private static function floorId(mixed $value): string
    {
        if (!is_string($value) || !preg_match('/^(0|-?[1-9][0-9]*)$/D', $value) || (string)(int)$value !== $value) {
            throw new ApiError('invalidFloor');
        }
        return $value;
    }

    private static function exhibitId(mixed $value): string
    {
        if (!is_string($value)) {
            throw new ApiError('invalidId');
        }
        return HumanFiles::filename($value);
    }

    public static function requestId(mixed $value): string
    {
        if (!is_string($value) || !preg_match('/^[a-zA-Z0-9_-]{8,80}$/D', $value)) {
            throw new ApiError('invalidId');
        }
        return $value;
    }

    private function path(string $root, string $relative): string
    {
        $path = $root;
        foreach (explode('/', $relative) as $part) {
            if (!in_array($part, ['.floors.json', '.exhibit.json'], true)) {
                HumanFiles::filename($part);
            }
            $path .= '/' . $part;
            if (is_link($path)) {
                throw new ApiError('invalidPath');
            }
        }
        return $path;
    }

    private function readJson(string $path): array
    {
        if (is_link($path)) throw new ApiError('invalidPath');
        if (!is_file($path)) return [];
        $body = file_get_contents($path);
        if ($body === false) throw new ApiError('storage', 503);
        try {
            $data = json_decode($body, true, 128, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ApiError('invalidMetadata', 503);
        }
        if (!is_array($data)) throw new ApiError('invalidMetadata', 503);
        return $data;
    }

    private function writeJson(string $path, array $value): void
    {
        $body = json_encode($value, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
        $this->write($path, $body);
    }

    private function write(string $path, string $body): void
    {
        $this->files->write($path, $body);
    }

    private function lock(Closure $action): mixed
    {
        if ($this->locked) return $action();
        return Files::lock($this->assets . "\n" . $this->exhibits, function () use ($action) {
            $this->locked = true;
            try {
                return $this->files->transaction($action);
            } finally {
                $this->locked = false;
            }
        });
    }

    private static function identity(): array
    {
        return ['position' => [0, 0, 0], 'rotation' => [0, 0, 0], 'scale' => [1, 1, 1]];
    }

    private static function transform(mixed $value): array
    {
        if (!is_array($value)) {
            throw new ApiError('invalidTransform');
        }
        $result = [];
        foreach (['position', 'rotation', 'scale'] as $key) {
            $vector = $value[$key] ?? null;
            if (!is_array($vector) || count($vector) !== 3) {
                throw new ApiError('invalidTransform');
            }
            foreach ($vector as $number) {
                if (!is_numeric($number) || !is_finite((float)$number) || abs((float)$number) > 100000 ||
                    ($key === 'scale' && ((float)$number < .001 || (float)$number > 1000))) {
                    throw new ApiError('invalidTransform');
                }
            }
            $result[$key] = array_map('floatval', array_values($vector));
        }
        return $result;
    }

    private static function views(mixed $value): array
    {
        if (!is_array($value)) {
            throw new ApiError('invalidView');
        }
        $result = [];
        foreach (['top', 'three'] as $key) {
            if (!isset($value[$key])) {
                continue;
            }
            $view = $value[$key];
            foreach (['position', 'target'] as $part) {
                if (!isset($view[$part]) || !is_array($view[$part]) || count($view[$part]) !== 3) {
                    throw new ApiError('invalidView');
                }
                foreach ($view[$part] as $number) {
                    if (!is_numeric($number) || !is_finite((float)$number) || abs((float)$number) > 100000) {
                        throw new ApiError('invalidView');
                    }
                }
                $result[$key][$part] = array_map('floatval', array_values($view[$part]));
            }
            if ($result[$key]['position'] === $result[$key]['target'] ||
                !is_numeric($view['span'] ?? null) || $view['span'] <= 0 || $view['span'] > 100000) {
                throw new ApiError('invalidView');
            }
            $result[$key]['span'] = (float)$view['span'];
            $result[$key]['mode'] = $key === 'top' ? 'top' : 'perspective';
        }
        return $result;
    }

    private static function readTransform(mixed $value): array
    {
        try {
            return self::transform($value);
        } catch (ApiError) {
            return self::identity();
        }
    }

    private static function readViews(mixed $value): array
    {
        $views = [];
        foreach (['top', 'three'] as $key) {
            if (!is_array($value) || !isset($value[$key])) {
                continue;
            }
            try {
                $views += self::views([$key => $value[$key]]);
            } catch (ApiError) {
                continue;
            }
        }
        return $views;
    }

    private function floorNames(): array
    {
        return $this->readJson($this->path($this->assets, 'Floors/.floors.json'));
    }

    private function floorDirectories(): array
    {
        $root = $this->path($this->assets, 'Floors');
        if (!is_dir($root)) {
            return [];
        }
        $floors = [];
        foreach (scandir($root) ?: [] as $name) {
            try {
                self::floorId($name);
            } catch (ApiError) {
                continue;
            }
            if (is_dir($root . '/' . $name) && !is_link($root . '/' . $name)) {
                $floors[] = $name;
            }
        }
        usort($floors, fn($a, $b) => (int)$a <=> (int)$b);
        return $floors;
    }

    private function exhibitDirectories(): array
    {
        $folders = [];
        foreach (scandir($this->exhibits) ?: [] as $name) {
            if ($name[0] === '.' || is_link($this->exhibits . '/' . $name) || !is_dir($this->exhibits . '/' . $name)) {
                continue;
            }
            try {
                self::exhibitId($name);
                $folders[] = $name;
            } catch (ApiError) {
                continue;
            }
        }
        natcasesort($folders);
        return array_values($folders);
    }

    private function modelFiles(): array
    {
        $files = [];
        $hardware = $this->path($this->assets, 'HardwareModels');
        if (is_dir($hardware)) {
            foreach (scandir($hardware) ?: [] as $name) {
                if ($name[0] === '.' || !preg_match('/\.glb$/iu', $name)) {
                    continue;
                }
                try {
                    HumanFiles::filename($name);
                } catch (ApiError) {
                    continue;
                }
                $file = 'HardwareModels/' . $name;
                if (is_file($hardware . '/' . $name) && !is_link($hardware . '/' . $name)) {
                    $files[] = $file;
                }
            }
        }
        foreach ($this->floorDirectories() as $id) {
            $file = 'Floors/' . $id . '/model.glb';
            if (is_file($this->path($this->assets, $file))) {
                $files[] = $file;
            }
        }
        sort($files, SORT_NATURAL | SORT_FLAG_CASE);
        return $files;
    }

    public function snapshot(): array
    {
        return $this->lock(fn() => $this->readSnapshot());
    }

    private function readSnapshot(): array
    {
        $modelFiles = $this->modelFiles();
        $assets = [];
        foreach ($modelFiles as $file) {
            $path = $this->path($this->assets, $file);
            $assets[] = [
                'id' => $file,
                'name' => pathinfo($file, PATHINFO_FILENAME),
                'url' => 'api.php?action=asset&kind=model&id=' . rawurlencode($file),
                'kind' => str_starts_with($file, 'Floors/') ? 'floor' : 'hardware',
                'file' => $file
            ];
        }
        $labels = $this->floorNames();
        $floors = [];
        $structureParts = [hash('sha256', json_encode($labels))];
        foreach ($this->floorDirectories() as $id) {
            $entry = $labels[$id] ?? [];
            $entry = is_array($entry) ? $entry : ['de' => $entry, 'en' => $entry];
            $floors[] = [
                'id' => $id,
                'names' => [
                    'de' => is_string($entry['de'] ?? null) && trim($entry['de']) !== '' ? $entry['de'] : $id,
                    'en' => is_string($entry['en'] ?? null) && trim($entry['en']) !== '' ? $entry['en'] : $id
                ],
                'order' => (int)$id,
                'modelId' => in_array('Floors/' . $id . '/model.glb', $modelFiles, true) ? 'Floors/' . $id . '/model.glb' : null,
                'transform' => self::identity(),
                'views' => (object)self::readViews($entry['views'] ?? []),
                'lastEditedBy' => is_string($entry['lastEditedBy'] ?? null) ? $entry['lastEditedBy'] : '',
                'revision' => hash('sha256', json_encode($entry))
            ];
            $structureParts[] = 'floor:' . $id;
        }
        $floorIds = array_column($floors, 'id');
        $exhibits = [];
        $contentParts = [];
        foreach ($this->exhibitDirectories() as $id) {
            $path = $this->path($this->exhibits, $id . '/.exhibit.json');
            $raw = is_file($path) ? file_get_contents($path) : '';
            $meta = $this->readJson($path);
            $assignedFloor = isset($meta['floor']) ? (string)$meta['floor'] : null;
            $floorId = in_array($assignedFloor, $floorIds, true) ? $assignedFloor : null;
            $models = [];
            foreach (is_array($meta['models'] ?? null) ? $meta['models'] : [] as $instance) {
                if (
                    is_array($instance) && is_string($instance['model'] ?? null) &&
                    in_array($instance['model'], $modelFiles, true) &&
                    str_starts_with($instance['model'], 'HardwareModels/')
                ) {
                    try {
                        $models[] = [
                            'model' => $instance['model'],
                            'transform' => self::transform($instance['transform'] ?? self::identity())
                        ];
                    } catch (ApiError) {
                        continue;
                    }
                }
            }
            $content = $this->human->read($id);
            $revision = hash('sha256', $raw ?: '');
            $exhibits[] = [
                'id' => $id,
                'name' => $id,
                'floorId' => $floorId,
                'status' => in_array($meta['status'] ?? null, ['ok', 'problem', 'retired'], true) ? $meta['status'] : 'ok',
                'lastEditedBy' => is_string($meta['lastEditedBy'] ?? null) ? $meta['lastEditedBy'] : '',
                'transform' => self::readTransform($meta['transform'] ?? null),
                'models' => $models,
                'placed' => $floorId !== null && count($models) > 0,
                'views' => (object)self::readViews($meta['views'] ?? []),
                'revision' => $revision,
                ...$content
            ];
            $structureParts[] = 'exhibit:' . $id . ':' . $revision;
            $contentParts[] = $id . ':' . $content['contentTag'];
        }
        foreach ($modelFiles as $file) {
            $path = $this->path($this->assets, $file);
            $structureParts[] = $file . ':' . filesize($path) . ':' . filemtime($path);
        }
        $structureRevision = hash('sha256', implode("\n", $structureParts));
        return [
            'datasetKey' => hash('sha256', $this->assets . "\n" . $this->exhibits),
            'revision' => hash('sha256', $structureRevision . implode("\n", $contentParts)),
            'structureRevision' => $structureRevision,
            'floors' => $floors,
            'exhibits' => $exhibits,
            'assets' => $assets
        ];
    }

    private function exhibitMeta(array $record, array $floorIds, array $modelIds, string $signature): array
    {
        $floor = $record['floorId'] ?? null;
        if ($floor !== null && $floor !== '' && !in_array($floor, $floorIds, true)) {
            throw new ApiError('invalidFloor');
        }
        $status = $record['status'] ?? 'ok';
        if (!in_array($status, ['ok', 'problem', 'retired'], true)) {
            throw new ApiError('invalidStatus');
        }
        $models = [];
        foreach ($record['models'] ?? [] as $instance) {
            $model = $instance['model'] ?? null;
            if (!is_string($model) || !in_array($model, $modelIds, true) || !str_starts_with($model, 'HardwareModels/')) {
                throw new ApiError('invalidModel');
            }
            $models[] = ['model' => $model, 'transform' => self::transform($instance['transform'] ?? null)];
        }
        if (count($models) > 100) {
            throw new ApiError('invalidModel');
        }
        if ($models && ($floor === null || $floor === '')) {
            throw new ApiError('invalidFloor');
        }
        $meta = [
            'floor' => $floor === null || $floor === '' ? null : (int)$floor,
            'status' => $status,
            'transform' => self::transform($record['transform'] ?? self::identity()),
            'models' => $models,
            'views' => (object)self::views($record['views'] ?? []),
            'lastEditedBy' => $signature
        ];
        return $meta;
    }

    private function assertEmptyExhibit(string $id): void
    {
        $root = $this->path($this->exhibits, $id);
        foreach (scandir($root) ?: [] as $name) {
            if (in_array($name, ['.', '..', '.exhibit.json'], true)) {
                continue;
            }
            if (in_array($name, ['Notizen', 'Fotos', 'Links'], true) && is_dir($root . '/' . $name) &&
                count(array_diff(scandir($root . '/' . $name) ?: [], ['.', '..'])) === 0) {
                continue;
            }
            throw new ApiError('notEmpty', 409);
        }
    }

    private function structure(array $payload, array $snapshot, string $signature): void
    {
        if (($payload['baseRevision'] ?? null) !== $snapshot['structureRevision']) {
            throw new ApiError('conflict', 409);
        }
        $changes = $payload['changes'] ?? null;
        if (!is_array($changes) || count($changes) > 300) {
            throw new ApiError('invalidInput');
        }
        $floorIds = array_column($snapshot['floors'], 'id');
        $modelIds = array_column($snapshot['assets'], 'id');
        $operations = [];
        $seen = [];
        foreach ($changes as $change) {
            $kind = $change['kind'] ?? '';
            $op = $change['op'] ?? '';
            if ($kind === 'floors') {
                throw new ApiError('assetsReadOnly');
            }
            if ($kind !== 'exhibits' || !in_array($op, ['put', 'delete'], true)) {
                throw new ApiError('invalidInput');
            }
            $id = self::exhibitId($change['id'] ?? null);
            if (isset($seen[$kind . ':' . $id])) {
                throw new ApiError('invalidInput');
            }
            $seen[$kind . ':' . $id] = true;
            $old = current(array_filter($snapshot[$kind], fn($item) => $item['id'] === $id)) ?: null;
            if ($old && ($change['baseRevision'] ?? null) !== $old['revision']) {
                throw new ApiError('conflict', 409);
            }
            if ($op === 'delete') {
                if (!$old) {
                    throw new ApiError('invalidInput');
                }
                $this->assertEmptyExhibit($id);
                $operations[] = ['deleteExhibit', $id];
                continue;
            }
            $record = $change['record'] ?? null;
            if (!is_array($record) || ($record['id'] ?? null) !== $id) {
                throw new ApiError('invalidId');
            }
            if (($record['name'] ?? null) !== $id) {
                throw new ApiError('invalidInput');
            }
            $operations[] = ['putExhibit', $id, $this->exhibitMeta($record, $floorIds, $modelIds, $signature)];
        }
        foreach ($operations as $operation) {
            [$op, $id] = $operation;
            $value = $operation[2] ?? null;
            if ($op === 'putExhibit') {
                $path = $this->path($this->exhibits, $id);
                $this->files->directory($path);
                $this->writeJson($path . '/.exhibit.json', $value);
            } else {
                $path = $this->path($this->exhibits, $id);
                $this->files->remove($path . '/.exhibit.json');
                foreach (['Notizen', 'Fotos', 'Links'] as $folder) {
                    if (is_dir($path . '/' . $folder)) {
                        $this->files->remove($path . '/' . $folder);
                    }
                }
                $this->files->remove($path);
            }
        }
    }

    public function mutate(array $payload, array $uploads = []): array
    {
        self::requestId($payload['requestId'] ?? null);
        $action = $payload['action'] ?? '';
        $signed = !in_array($action, ['status', 'putLink', 'deleteLink'], true);
        $signature = $signed ? self::signature($payload['signature'] ?? null) : '';
        return $this->lock(function () use ($payload, $action, $signature, $uploads) {
            $snapshot = $this->snapshot();
            if ($action === 'structure') {
                $this->structure($payload, $snapshot, $signature);
            } else {
                $id = self::exhibitId($payload['exhibitId'] ?? null);
                $record = current(array_filter($snapshot['exhibits'], fn($item) => $item['id'] === $id)) ?: null;
                if (!$record) {
                    throw new ApiError('notFound', 404);
                }
                if (in_array($action, ['status', 'correctNote', 'deleteNote', 'putLink', 'deleteLink'], true) &&
                    ($payload['baseRevision'] ?? null) !== $record['revision']) {
                    throw new ApiError('conflict', 409);
                }
                if (in_array($action, ['correctNote', 'deleteNote', 'putLink', 'deleteLink'], true) &&
                    ($payload['contentTag'] ?? null) !== $record['contentTag']) {
                    throw new ApiError('conflict', 409);
                }
                if ($action === 'putLink') {
                    $this->human->putLink(
                        $id,
                        isset($payload['linkId']) ? self::text($payload['linkId']) : null,
                        self::text($payload['title'] ?? null),
                        self::url($payload['url'] ?? null),
                        self::text($payload['description'] ?? '', 1000, false)
                    );
                } elseif ($action === 'deleteLink') {
                    $this->human->deleteLink($id, self::text($payload['linkId'] ?? null));
                } elseif ($action === 'status') {
                    if (($payload['baseRevision'] ?? null) !== $record['revision']) {
                        throw new ApiError('conflict', 409);
                    }
                    $this->status($id, $record, $payload['status'] ?? null);
                } elseif (in_array($action, ['note', 'correctNote', 'deleteNote'], true)) {
                    if ($action === 'deleteNote' && $uploads) throw new ApiError('invalidImage');
                    if ($action === 'note' && isset($payload['status']) && $payload['status'] !== '') {
                        if (($payload['baseRevision'] ?? null) !== $record['revision'] && $payload['status'] !== $record['status']) {
                            throw new ApiError('conflict', 409);
                        }
                        if (!in_array($payload['status'], ['ok', 'problem', 'retired'], true)) {
                            throw new ApiError('invalidStatus');
                        }
                    }
                    $note = null;
                    if ($action === 'note') {
                        $images = $payload['images'] ?? [];
                        if (!is_array($images) || count($images) > 8) {
                            throw new ApiError('invalidImage');
                        }
                        $note = [
                            'id' => $payload['requestId'],
                            'body' => self::text($payload['body'] ?? '', 50000, false),
                            'images' => $images
                        ];
                        if ($note['body'] === '' && !$images && !$uploads) {
                            throw new ApiError('bodyRequired');
                        }
                    } else {
                        $note = current(array_filter($record['notes'], fn($item) => $item['id'] === ($payload['noteId'] ?? null))) ?: null;
                        if (!$note || isset($note['deleted'])) {
                            throw new ApiError('notFound', 404);
                        }
                        if ($action === 'correctNote') {
                            $note['body'] = self::text($payload['body'] ?? '', 50000, false);
                            $note['images'] = $payload['images'] ?? [];
                            if (!is_array($note['images']) || count($note['images']) > 8 ||
                                ($note['body'] === '' && !$note['images'] && !$uploads)) {
                                throw new ApiError('bodyRequired');
                            }
                        }
                    }
                    if (count($note['images']) + count($uploads) > 8) throw new ApiError('invalidImage');
                    foreach ($uploads as $upload) {
                        $photo = $this->human->savePhoto($id, $signature,
                            self::requestId($upload['requestId'] ?? null), $upload['bytes'], $upload['mime']);
                        $note['images'][] = $photo['id'];
                    }
                    $this->human->saveNote($id, $action, $note, $signature, $payload['requestId']);
                    if ($action === 'note' && isset($payload['status']) && $payload['status'] !== '') {
                        $this->status($id, $record, $payload['status']);
                    }
                } else {
                    throw new ApiError('invalidInput');
                }
            }
            return ['saved' => true, 'requestId' => $payload['requestId'], 'snapshot' => $this->snapshot()];
        });
    }

    private function status(string $id, array $record, mixed $status): void
    {
        if (!in_array($status, ['ok', 'problem', 'retired'], true)) {
            throw new ApiError('invalidStatus');
        }
        if ($record['status'] === $status) {
            return;
        }
        $path = $this->path($this->exhibits, $id . '/.exhibit.json');
        $meta = $this->readJson($path);
        $meta['status'] = $status;
        unset($meta['statusBy']);
        $this->writeJson($path, $meta);
    }

    public static function validateGlb(string $bytes): void
    {
        if (strlen($bytes) < 20 || substr($bytes, 0, 4) !== 'glTF') {
            throw new ApiError('invalidModel');
        }
        $header = unpack('Vversion/Vlength/VjsonLength/Vtype', substr($bytes, 4, 16));
        if ($header['version'] !== 2 || $header['length'] !== strlen($bytes) ||
            $header['type'] !== 0x4e4f534a || $header['jsonLength'] > strlen($bytes) - 20) {
            throw new ApiError('invalidModel');
        }
        $json = json_decode(substr($bytes, 20, $header['jsonLength']), true);
        if (!is_array($json) || ($json['asset']['version'] ?? null) !== '2.0' ||
            empty($json['meshes']) || !empty($json['extensionsRequired'])) {
            throw new ApiError('invalidModel');
        }
        foreach (array_merge($json['buffers'] ?? [], $json['images'] ?? []) as $item) {
            if (isset($item['uri'])) {
                throw new ApiError('externalModelResource');
            }
        }
    }

    public function asset(string $kind, string $id): array
    {
        if ($kind === 'image') {
            return $this->human->photo(self::text($id));
        }
        if ($kind !== 'model' || !in_array($id, $this->modelFiles(), true)) {
            throw new ApiError('notFound', 404);
        }
        $path = $this->path($this->assets, $id);
        $bytes = file_get_contents($path);
        if ($bytes === false) {
            throw new ApiError('storage', 503);
        }
        self::validateGlb($bytes);
        return ['path' => $path, 'mime' => 'model/gltf-binary'];
    }

    public function namedPhoto(string $exhibit, string $name): array
    {
        return $this->human->namedPhoto(self::exhibitId($exhibit), $name);
    }
}
