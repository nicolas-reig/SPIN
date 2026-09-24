<?php

declare(strict_types=1);

final class ApiError extends RuntimeException
{
    public function __construct(public readonly string $key, public readonly int $status = 422, public readonly array $details = [])
    {
        parent::__construct($key);
    }
}

final class Store
{
    private string $root;
    private $lock;

    public function __construct(string $root, private readonly array $seed, private readonly ?Closure $fault = null)
    {
        if (!is_dir($root) && !mkdir($root, 0700, true)) {
            throw new ApiError('storage', 503);
        }
        $this->root = realpath($root) ?: throw new ApiError('storage', 503);
        if (is_link($root)) {
            throw new ApiError('storage', 503);
        }
        foreach (['locks','exhibits','floors','trash','logs','journal','blobs','models'] as $dir) {
            $this->directory($dir);
        }
    }

    private function path(string $rel): string
    {
        if (str_contains($rel, '..') || str_contains($rel, '\\') || str_starts_with($rel, '/')) {
            throw new ApiError('invalidPath');
        }
        $cursor = $this->root;
        foreach (explode('/', $rel) as $part) {
            $cursor .= '/' . $part;
            if (is_link($cursor)) {
                throw new ApiError('invalidPath');
            }
        }
        return $this->root . '/' . $rel;
    }

    private function directory(string $rel): void
    {
        $p = $this->path($rel);
        if (!is_dir($p) && !mkdir($p, 0700, true)) {
            throw new ApiError('storage', 503);
        }
    }

    private function encode(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    }

    private function read(string $path): array
    {
        $s = file_get_contents($this->path($path));
        if ($s === false) {
            throw new ApiError('storage', 503);
        }
        return json_decode($s, true, 512, JSON_THROW_ON_ERROR);
    }

    private function atomic(string $rel, string $body): void
    {
        $path = $this->path($rel);
        $tmp = $path . '.' . bin2hex(random_bytes(8)) . '.tmp';
        $f = fopen($tmp, 'xb');
        if (!$f) {
            throw new ApiError('storage', 503);
        }
        try {
            if (fwrite($f, $body) !== strlen($body) || !fflush($f) || !fsync($f)) {
                throw new ApiError('storage', 503);
            }
        } finally {
            fclose($f);
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new ApiError('storage', 503);
        }
    }

    private function trip(string $point): void
    {
        if ($this->fault) {
            ($this->fault)($point);
        }
    }

    private function locked(Closure $action): mixed
    {
        $this->lock = fopen($this->path('locks/store.lock'), 'c');
        if (!$this->lock) {
            throw new ApiError('storage', 503);
        }
        $deadline = microtime(true) + 3;
        while (!flock($this->lock, LOCK_EX | LOCK_NB)) {
            if (microtime(true) > $deadline) {
                fclose($this->lock);
                throw new ApiError('busy', 409);
            }
            usleep(20000);
        }
        try {
            $this->recover();
            if (!file_exists($this->path('catalog.json'))) {
                $this->initialize();
            }
            return $action();
        } finally {
            flock($this->lock, LOCK_UN);
            fclose($this->lock);
        }
    }

    private function resourceLock(string $id, Closure $action): mixed
    {
        self::id($id);
        $f = fopen($this->path('locks/' . $id . '.lock'), 'c');
        if (!$f || !flock($f, LOCK_EX | LOCK_NB)) {
            if ($f) {
                fclose($f);
            }
            throw new ApiError('busy', 409);
        }
        try {
            return $action();
        } finally {
            flock($f, LOCK_UN);
            fclose($f);
        }
    }

    private function appendLog(array $record): void
    {
        $this->trip('before_log');
        $p = $this->path('logs/edit-changes.jsonl');
        $f = fopen($p, 'c+b');
        if (!$f) {
            throw new ApiError('storage', 503);
        }
        try {
            $good = 0;
            $seen = false;
            while (($line = fgets($f)) !== false) {
                $row = json_decode($line, true);
                if (!is_array($row) || !str_ends_with($line, "\n")) {
                    if (!ftruncate($f, $good)) {
                        throw new ApiError('storage', 503);
                    }
                    break;
                }
                if (($row['changeSetId'] ?? '') === $record['changeSetId']) {
                    $seen = true;
                }
                $good = ftell($f);
            }
            if (!$seen) {
                fseek($f, 0, SEEK_END);
                $line = json_encode($record, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
                if (fwrite($f, $line) !== strlen($line)) {
                    throw new ApiError('storage', 503);
                }
            }
            if (!fflush($f) || !fsync($f)) {
                throw new ApiError('storage', 503);
            }
        } finally {
            fclose($f);
        }
    }

    private function recover(): void
    {
        if (!file_exists($this->path('journal/pending.json'))) {
            return;
        }
        $j = $this->read('journal/pending.json');
        if ($j['log'] !== null) {
            $this->appendLog($j['log']);
        }
        $this->trip('after_log');
        $this->atomic('catalog.json', $this->encode($j['catalog']));
        $this->trip('after_publish');
        if (!unlink($this->path('journal/pending.json'))) {
            throw new ApiError('storage', 503);
        }
    }

    private function publish(array $catalog, ?array $log): void
    {
        $this->trip('before_journal');
        $this->atomic('journal/pending.json', $this->encode(['catalog' => $catalog,'log' => $log]));
        $this->trip('after_journal');
        $this->recover();
    }

    private function stage(string $kind, array $record, string $commit): string
    {
        $id = self::id($record['id']);
        $rel = "$kind/$id/$commit";
        $this->directory($rel);
        $meta = $record;
        unset($meta['notes']);
        if (isset($record['notes'])) {
            $this->directory($rel . '/notes');
            $meta['noteIds'] = [];
            foreach ($record['notes'] as $note) {
                $nid = self::id($note['id']);
                $body = $note['body'];
                unset($note['body']);
                $meta['noteIds'][] = $nid;
                $this->atomic("$rel/notes/$nid.md", $body);
                $this->atomic("$rel/notes/$nid.json", $this->encode($note));
            }
        }
        $links = $meta['links'] ?? null;
        unset($meta['links']);
        if ($links !== null) {
            $this->atomic($rel . '/links.json', $this->encode($links));
        }
        $this->atomic($rel . '/record.json', $this->encode($meta));
        return $rel;
    }

    private function record(string $rel): array
    {
        $r = $this->read($rel . '/record.json');
        if (isset($r['noteIds'])) {
            $r['notes'] = [];
            foreach ($r['noteIds'] as $nid) {
                self::id($nid);
                $n = $this->read("$rel/notes/$nid.json");
                $n['body'] = file_get_contents($this->path("$rel/notes/$nid.md"));
                $r['notes'][] = $n;
            }
            unset($r['noteIds']);
            $r['links'] = $this->read($rel . '/links.json');
        }
        return $r;
    }

    private function initialize(): void
    {
        $c = ['schema' => 1,'revision' => 1,'structureRevision' => 1,'floors' => [],'exhibits' => [],'trash' => [],'assets' => $this->seed['assets'],'requests' => []];
        foreach (['floors','exhibits'] as $kind) {
            foreach ($this->seed[$kind] as $r) {
                $c[$kind][$r['id']] = $this->stage($kind, $r, 'seed');
            }
        }
        $this->publish($c, null);
    }

    public function snapshot(): array
    {
        return $this->locked(function () {
                return $this->snapshotFrom($this->read('catalog.json'));
        });
    }

    private function snapshotFrom(array $c): array
    {
        $out = ['schema' => 1,'revision' => $c['revision'],'structureRevision' => $c['structureRevision'],'assets' => array_values($c['assets'])];
        foreach (['floors','exhibits','trash'] as $kind) {
            $out[$kind] = [];
            foreach ($c[$kind] as $ref) {
                $out[$kind][] = $this->record($ref);
            }
        }
        return $out;
    }
    public static function id(mixed $s): string
    {
        if (!is_string($s) || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/D', $s)) {
            throw new ApiError('invalidId');
        }
        return $s;
    }
    public static function text(mixed $s, int $max = 200, bool $required = true): string
    {
        if (!is_string($s) || strlen($s) > $max || ($required && trim($s) === '')) {
            throw new ApiError('invalidInput');
        }
        return trim($s);
    }
    public static function signature(mixed $s): string
    {
        if (!is_string($s) || trim($s) === '' || strlen($s) > 120) {
            throw new ApiError('signatureRequired');
        }
        return trim($s);
    }
    public static function url(mixed $s): string
    {
        $s = self::text($s, 2048);
        $p = parse_url($s);
        if (!filter_var($s, FILTER_VALIDATE_URL) || !in_array(strtolower($p['scheme'] ?? ''), ['http','https'], true) || empty($p['host']) || isset($p['user']) || isset($p['pass']) || preg_match('/[\x00-\x20\x7f]/', $s)) {
            throw new ApiError('invalidUrl');
        }
        return $s;
    }
    private static function transform(mixed $t): array
    {
        if (!is_array($t)) {
            throw new ApiError('invalidTransform');
        }$out = [];
        foreach (['position','rotation','scale'] as $key) {
            if (!isset($t[$key]) || !is_array($t[$key]) || count($t[$key]) !== 3) {
                throw new ApiError('invalidTransform');
            }
            foreach ($t[$key] as $v) {
                if (!is_numeric($v) || !is_finite((float)$v) || abs((float)$v) > 100000 || ($key === 'scale' && ($v < 0.001 || $v > 1000))) {
                    throw new ApiError('invalidTransform');
                }
            }
            $out[$key] = array_map('floatval', array_values($t[$key]));
        }
        return $out;
    }

    private function structure(array $row, string $kind, array $floorIds, array $assets): array
    {
        $id = self::id($row['id'] ?? null);
        $asset = $row['modelId'] ?? null;
        if ($asset !== null && !isset($assets[self::id($asset)])) {
            throw new ApiError('invalidModel');
        }
        $out = ['id' => $id,'modelId' => $asset,'transform' => self::transform($row['transform'] ?? null)];
        if ($kind === 'floors') {
            if ($asset === null) {
                throw new ApiError('invalidModel');
            }
            $out['names'] = ['de' => self::text($row['names']['de'] ?? null),'en' => self::text($row['names']['en'] ?? null)];
            foreach (['order','elevation'] as $k) {
                if (!isset($row[$k]) || !is_numeric($row[$k]) || !is_finite((float)$row[$k]) || abs((float)$row[$k]) > 10000) {
                    throw new ApiError('invalidInput');
                }$out[$k] = (float)$row[$k];
            }
            $out['camera'] = self::transform($row['camera'] ?? ['position' => [40,40,40],'rotation' => [0,0,0],'scale' => [1,1,1]]);
        } else {
            $out['name'] = self::text($row['name'] ?? null);
            $out['location'] = self::text($row['location'] ?? null, 200, false);
            $out['floorId'] = self::id($row['floorId'] ?? null);
            if (!in_array($out['floorId'], $floorIds, true)) {
                throw new ApiError('invalidFloor');
            }
            if (!is_bool($row['placed'] ?? null)) {
                throw new ApiError('invalidInput');
            }$out['placed'] = $row['placed'];
        }
        return $out;
    }

    private function checkRevision(array $r, mixed $revision): void
    {
        if (!is_int($revision) || $revision !== $r['revision']) {
            throw new ApiError('conflict', 409, ['current' => $r]);
        }
    }

    private function retry(array $c, array $p): ?array
    {
        $id = self::id($p['requestId'] ?? null);
        $hash = hash('sha256', $this->encode($p));
        if (isset($c['requests'][$id])) {
            if ($c['requests'][$id]['hash'] !== $hash) {
                throw new ApiError('requestConflict', 409);
            }
            return ['saved' => true,'requestId' => $id,'snapshot' => $this->snapshotFrom($c)];
        }
        return null;
    }

    public function mutate(array $p): array
    {
        self::signature($p['signature'] ?? null);
        self::id($p['requestId'] ?? null);
        return $this->locked(function () use ($p) {
            $c = $this->read('catalog.json');
            if ($retry = $this->retry($c, $p)) {
                return $retry;
            }
            $action = $p['action'] ?? '';
            $sig = self::signature($p['signature']);
            $now = gmdate('Y-m-d\TH:i:s\Z');
            $commit = $p['requestId'];
            $log = null;
            if ($action === 'structure') {
                if (($p['baseRevision'] ?? null) !== $c['structureRevision']) {
                    throw new ApiError('conflict', 409, ['current' => $this->snapshotFrom($c)]);
                }
                $changes = $p['changes'] ?? null;
                if (!is_array($changes) || count($changes) > 300) {
                    throw new ApiError('invalidInput');
                }
                $actions = [];
                $floorIds = array_keys($c['floors']);
                foreach ($changes as $ch) {
                    if (($ch['kind'] ?? '') === 'floors' && ($ch['op'] ?? '') === 'put') {
                        $floorIds[] = self::id($ch['record']['id'] ?? null);
                    }
                }
                $seen = [];
                foreach ($changes as $ch) {
                    $kind = $ch['kind'] ?? '';
                    $op = $ch['op'] ?? '';
                    if (!in_array($kind, ['exhibits','floors'], true)) {
                        throw new ApiError('invalidInput');
                    }
                    $id = self::id($ch['id'] ?? ($ch['record']['id'] ?? null));
                    if (isset($seen[$kind . $id])) {
                        throw new ApiError('invalidInput');
                    }$seen[$kind . $id] = true;
                    $old = isset($c[$kind][$id]) ? $this->record($c[$kind][$id]) : null;
                    if ($op === 'restore') {
                        if ($kind !== 'exhibits' || $old || !isset($c['trash'][$id])) {
                            throw new ApiError('conflict', 409);
                        }
                        $new = $this->record($c['trash'][$id]);
                        if (!in_array($new['floorId'], $floorIds, true)) {
                            throw new ApiError('invalidFloor');
                        }
                        unset($new['deleted']);
                        $new['revision']++;
                        $c['exhibits'][$id] = $this->stage('exhibits', $new, $commit);
                        unset($c['trash'][$id]);
                    } elseif ($op === 'delete') {
                        if ($kind !== 'exhibits' || !$old) {
                            throw new ApiError('invalidInput');
                        }$this->checkRevision($old, $ch['baseRevision'] ?? null);
                        $new = $old;
                        $new['revision']++;
                        $new['deleted'] = ['signature' => $sig,'at' => $now];
                        $c['trash'][$id] = $this->stage('trash', $new, $commit);
                        unset($c['exhibits'][$id]);
                    } elseif ($op === 'put') {
                        if ($old) {
                            $this->checkRevision($old, $ch['baseRevision'] ?? null);
                        } elseif (isset($c['trash'][$id])) {
                            throw new ApiError('conflict', 409);
                        }
                        $struct = $this->structure($ch['record'] ?? [], $kind, $floorIds, $c['assets']);
                        if ($struct['id'] !== $id) {
                            throw new ApiError('invalidId');
                        }
                        $new = array_replace($old ?? ['revision' => 0], $struct);
                        if (!$old && $kind === 'exhibits') {
                            $status = $ch['status'] ?? null;
                            if (!in_array($status, ['ok','problem','retired'], true)) {
                                throw new ApiError('invalidStatus');
                            }$new += ['status' => $status,'statusChanged' => ['signature' => $sig,'at' => $now],'notes' => [],'links' => []];
                        }
                        if ($old && $new == $old) {
                            continue;
                        }
                        $new['revision']++;
                        $c[$kind][$id] = $this->resourceLock($id, fn()=>$this->stage($kind, $new, $commit));
                    } else {
                        throw new ApiError('invalidInput');
                    }
                    $actions[] = ['op' => $op,'kind' => $kind,'id' => $id,'label' => $new['name'] ?? $new['names'],'before' => $old,'after' => $new];
                }
                if (!$actions) {
                    return ['saved' => true,'unchanged' => true,'snapshot' => $this->snapshotFrom($c)];
                }
                $c['structureRevision']++;
                $log = ['changeSetId' => $commit,'at' => $now,'signature' => $sig,'baseRevision' => $p['baseRevision'],'resultRevision' => $c['structureRevision'],'actions' => $actions];
            } elseif (in_array($action, ['note','status','links','correctNote'], true)) {
                $id = self::id($p['exhibitId'] ?? null);
                if (!isset($c['exhibits'][$id])) {
                    throw new ApiError('notFound', 404);
                }
                $r = $this->record($c['exhibits'][$id]);
                $this->checkRevision($r, $p['baseRevision'] ?? null);
                if ($action === 'note' || $action === 'correctNote') {
                    $body = self::text($p['body'] ?? '', 50000, false);
                    $images = $p['images'] ?? [];
                    if (!is_array($images) || count($images) > 8) {
                        throw new ApiError('invalidImage');
                    }
                    foreach ($images as $image) {
                        self::id($image);
                        if (!file_exists($this->path('blobs/' . $image . '.json'))) {
                            throw new ApiError('invalidImage');
                        }
                    }
                    if ($body === '' && !$images) {
                        throw new ApiError('bodyRequired');
                    }
                    if ($action === 'note') {
                        array_unshift($r['notes'], ['id' => $commit,'body' => $body,'images' => $images,'author' => $sig,'at' => $now,'corrections' => []]);
                    } else {
                        $found = false;
                        foreach ($r['notes'] as &$n) {
                            if ($n['id'] === ($p['noteId'] ?? null)) {
                                                    $found = true;
                                                    $n['corrections'][] = ['signature' => $sig,'at' => $now,'previousBody' => $n['body'],'previousImages' => $n['images']];
                                                    $n['body'] = $body;
                                                    $n['images'] = $images;
                            }
                        }
                        unset($n);
                        if (!$found) {
                            throw new ApiError('notFound', 404);
                        }
                    }
                }
                if ($action === 'status' || ($action === 'note' && isset($p['status']))) {
                    if (!in_array($p['status'] ?? null, ['ok','problem','retired'], true)) {
                        throw new ApiError('invalidStatus');
                    }
                    if ($r['status'] !== $p['status']) {
                        $r['status'] = $p['status'];
                        $r['statusChanged'] = ['signature' => $sig,'at' => $now];
                    }
                }
                if ($action === 'links') {
                    if (!is_array($p['links'] ?? null) || count($p['links']) > 100) {
                        throw new ApiError('invalidInput');
                    }
                    $links = [];
                    $ids = [];
                    foreach ($p['links'] as $link) {
                        $lid = self::id($link['id'] ?? null);
                        if (isset($ids[$lid])) {
                            throw new ApiError('invalidId');
                        }$ids[$lid] = true;
                        $links[] = ['id' => $lid,'title' => self::text($link['title'] ?? null),'url' => self::url($link['url'] ?? null),'description' => self::text($link['description'] ?? '', 1000, false),'signature' => $sig,'at' => $now];
                    }
                    $r['links'] = $links;
                }
                $r['revision']++;
                $c['exhibits'][$id] = $this->resourceLock($id, fn()=>$this->stage('exhibits', $r, $commit));
            } else {
                throw new ApiError('invalidInput');
            }
            $c['revision']++;
            $c['requests'][$commit] = ['hash' => hash('sha256', $this->encode($p)),'at' => $now];
            $this->publish($c, $log);
            return ['saved' => true,'requestId' => $commit,'snapshot' => $this->snapshotFrom($c)];
        });
    }

    public function upload(array $p, string $tmp): array
    {
        $sig = self::signature($p['signature'] ?? null);
        $id = self::id($p['requestId'] ?? null);
        $kind = $p['kind'] ?? '';
        $size = filesize($tmp);
        if (!$size || $size > 32 * 1024 * 1024) {
            throw new ApiError('fileTooLarge');
        }
        $bytes = file_get_contents($tmp);
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($tmp);
        $dims = null;
        if ($kind === 'image') {
            if ($size > 8 * 1024 * 1024) {
                throw new ApiError('fileTooLarge');
            }
            $info = @getimagesize($tmp);
            if (!$info || !in_array($mime, ['image/jpeg','image/png','image/webp'], true) || $info[0] > 10000 || $info[1] > 10000) {
                throw new ApiError('invalidImage');
            }
            $folder = 'blobs';
        } elseif ($kind === 'model') {
            self::validateGlb($bytes);
            $folder = 'models';
            $mime = 'model/gltf-binary';
            $dims = json_decode($p['dimensions'] ?? 'null', true);
            if (!is_array($dims) || count($dims) !== 3) {
                throw new ApiError('invalidModel');
            }foreach ($dims as $v) {
                if (!is_numeric($v) || !is_finite((float)$v) || $v < 0 || $v > 100000) {
                    throw new ApiError('invalidModel');
                }
            }
        } else {
            throw new ApiError('invalidInput');
        }
        return $this->locked(function () use ($p, $id, $sig, $bytes, $folder, $mime, $dims) {
            $hash = hash('sha256', $bytes);
            $meta = ['id' => $id,'hash' => $hash,'mime' => $mime,'signature' => $sig,'at' => gmdate('c')];
            if (file_exists($this->path("$folder/$id.json"))) {
                if ($this->read("$folder/$id.json")['hash'] !== $hash) {
                    throw new ApiError('requestConflict', 409);
                }
            } else {
                $this->atomic("$folder/$id.bin", $bytes);
                $this->atomic("$folder/$id.json", $this->encode($meta));
            }
            if ($folder === 'models') {
                $c = $this->read('catalog.json');
                if (!isset($c['assets'][$id])) {
                    $c['assets'][$id] = ['id' => $id,'name' => self::text($p['name'] ?? 'Model'),'url' => 'api.php?action=asset&kind=model&id=' . $id,'dimensions' => $dims,'source' => 'upload'];
                    $c['revision']++;
                    $this->publish($c, null);
                }
            }
            return ['id' => $id,'url' => 'api.php?action=asset&kind=' . ($folder === 'models' ? 'model' : 'image') . '&id=' . $id];
        });
    }
    public static function validateGlb(string $bytes): void
    {
        if (strlen($bytes) < 20 || substr($bytes, 0, 4) !== 'glTF') {
            throw new ApiError('invalidModel');
        }
        $h = unpack('Vversion/Vlength/VjsonLength/Vtype', substr($bytes, 4, 16));
        if ($h['version'] !== 2 || $h['length'] !== strlen($bytes) || $h['type'] !== 0x4e4f534a || $h['jsonLength'] > strlen($bytes) - 20) {
            throw new ApiError('invalidModel');
        }
        try {
            $g = json_decode(substr($bytes, 20, $h['jsonLength']), true, 128, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            throw new ApiError('invalidModel');
        }
        foreach (array_merge($g['buffers'] ?? [], $g['images'] ?? []) as $item) {
            if (isset($item['uri'])) {
                throw new ApiError('externalModelResource');
            }
        }
        if (($g['asset']['version'] ?? null) !== '2.0' || !isset($g['meshes']) || !is_array($g['meshes'])) {
            throw new ApiError('invalidModel');
        }
        if (!empty($g['extensionsRequired'])) {
            throw new ApiError('unsupportedModel');
        }
    }

    public function asset(string $kind, string $id): array
    {
        self::id($id);
        $folder = match ($kind) {
            'model'=>'models','image'=>'blobs',default=>throw new ApiError('notFound', 404)
        };
        return $this->locked(function () use ($folder, $id) {
            if (!file_exists($this->path("$folder/$id.json"))) {
                throw new ApiError('notFound', 404);
            }$m = $this->read("$folder/$id.json");
            return ['path' => $this->path("$folder/$id.bin"),'mime' => $m['mime']];
        });
    }
}
