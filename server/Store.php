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
    private ?HumanFiles $human = null;

    public function __construct(string $root, private readonly array $seed, private readonly ?Closure $fault = null, ?string $contentRoot = null)
    {
        if (!is_dir($root) && !mkdir($root, 0700, true)) {
            throw new ApiError('storage', 503);
        }
        $this->root = realpath($root) ?: throw new ApiError('storage', 503);
        if (is_link($root)) {
            throw new ApiError('storage', 503);
        }
        foreach (['locks','exhibits','floors','areas','trash','logs','journal','blobs','models','note-meta'] as $dir) {
            $this->directory($dir);
        }
        if ($contentRoot !== null) {
            $this->human = new HumanFiles($contentRoot);
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
        if ($this->human && in_array($kind, ['exhibits', 'trash'], true)) {
            $this->human->ensureExhibit($meta);
            unset($meta['notes'], $meta['links'], $meta['contentTag']);
            $this->atomic($rel . '/record.json', $this->encode($meta));
            return $rel;
        }
        unset($meta['notes']);
        if (isset($record['notes'])) {
            $this->directory($rel . '/notes');
            $meta['noteIds'] = [];
            foreach ($record['notes'] as $note) {
                $nid = self::id($note['id']);
                $body = $note['body'];
                unset($note['body']);
                if (isset($note['deleted'])) {
                    $header = ['status' => 'deleted', 'original_author' => $note['author'], 'original_created_at' => $note['at'], 'deleted_by' => $note['deleted']['signature'], 'deleted_at' => $note['deleted']['at']];
                    foreach (['original_created_at', 'deleted_at'] as $field) {
                        $local = (new DateTimeImmutable($header[$field]))->setTimezone(new DateTimeZone('Europe/Berlin'));
                        $header[$field . '_local'] = $local->format('d.m.Y H:i:s T');
                    }
                    $front = "---\n";
                    foreach ($header as $field => $value) {
                        $front .= $field . ': ' . json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
                    }
                    $front .= "---\n\n";
                    $note['headerBytes'] = strlen($front);
                    $body = $front . $body;
                }
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
        if ($this->human && isset($r['contentFolder'])) {
            $r = array_replace($r, $this->human->read($r));
            foreach ($r['notes'] as &$note) {
                $metaPath = 'note-meta/' . $note['id'] . '.json';
                if (file_exists($this->path($metaPath))) {
                    $meta = $this->read($metaPath);
                    if (($meta['fileHash'] ?? null) === $note['fileHash']) {
                        $note['corrections'] = $meta['corrections'] ?? [];
                    }
                }
            }
            unset($note);
            return $r;
        }
        if (isset($r['noteIds'])) {
            $r['notes'] = [];
            foreach ($r['noteIds'] as $nid) {
                self::id($nid);
                $n = $this->read("$rel/notes/$nid.json");
                $n['body'] = file_get_contents($this->path("$rel/notes/$nid.md"));
                if (isset($n['headerBytes'])) {
                    $n['body'] = substr($n['body'], $n['headerBytes']);
                    unset($n['headerBytes']);
                }
                $r['notes'][] = $n;
            }
            unset($r['noteIds']);
            $r['links'] = $this->read($rel . '/links.json');
        }
        return $r;
    }

    private function initialize(): void
    {
        $c = ['schema' => 1,'revision' => 1,'structureRevision' => 1,'floors' => [],'exhibits' => [],'areas' => [],'trash' => [],'assets' => $this->seed['assets'],'requests' => []];
        foreach (['floors','exhibits','areas'] as $kind) {
            foreach ($this->seed[$kind] ?? [] as $r) {
                if ($kind === 'exhibits') {
                    $this->assignContentFolder($c, $r);
                }
                $c[$kind][$r['id']] = $this->stage($kind, $r, 'seed');
            }
        }
        $this->publish($c, null);
    }

    private function assignContentFolder(array $catalog, array &$record): void
    {
        if (!$this->human || isset($record['contentFolder'])) {
            return;
        }
        $used = [];
        foreach (['exhibits', 'trash'] as $kind) {
            foreach ($catalog[$kind] ?? [] as $ref) {
                $other = $this->read($ref . '/record.json');
                if (isset($other['contentFolder'])) {
                    $used[mb_strtolower($other['contentFolder'])] = true;
                }
            }
        }
        $name = HumanFiles::filename($record['name']);
        $candidate = $name;
        $suffix = ' [' . substr(hash('sha256', $record['id']), 0, 8) . ']';
        for ($number = 2; isset($used[mb_strtolower($candidate)]); $number++) {
            $candidate = HumanFiles::filename(mb_strcut($name, 0, 140, 'UTF-8') . $suffix . ($number > 2 ? " ($number)" : ''));
        }
        $record['contentFolder'] = $candidate;
    }

    public function snapshot(): array
    {
        return $this->locked(function () {
            return $this->snapshotFrom($this->read('catalog.json'));
        });
    }

    private function snapshotFrom(array $c): array
    {
        $assets = array_values($c['assets']);
        if ($this->human) {
            foreach ($assets as &$asset) {
                $asset['url'] = 'api.php?action=asset&kind=model&id=' . rawurlencode($asset['id']);
            }
            unset($asset);
        }
        $out = ['schema' => 1,'revision' => $c['revision'],'structureRevision' => $c['structureRevision'],'assets' => $assets];
        foreach (['floors','exhibits','areas','trash'] as $kind) {
            $out[$kind] = [];
            foreach ($c[$kind] ?? [] as $ref) {
                $record = $this->record($ref);
                unset($record['contentFolder']);
                foreach ($record['notes'] ?? [] as &$note) {
                    unset($note['fileHash']);
                }
                unset($note);
                $out[$kind][] = $record;
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
        if (!filter_var($s, FILTER_VALIDATE_URL) || !in_array(strtolower($p['scheme'] ?? ''), ['http','https','smb','file','ftp'], true) || (empty($p['host']) && ($p['scheme'] ?? '') !== 'file') || isset($p['user']) || isset($p['pass']) || preg_match('/[\x00-\x20\x7f]/', $s)) {
            throw new ApiError('invalidUrl');
        }
        return $s;
    }
    private static function transform(mixed $t): array
    {
        if (!is_array($t)) {
            throw new ApiError('invalidTransform');
        }
        $out = [];
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

    private static function views(mixed $views, bool $required = false): array
    {
        if (!is_array($views) || array_diff(array_keys($views), ['top', 'three'])) {
            throw new ApiError('invalidView');
        }
        $out = [];
        foreach (['top', 'three'] as $key) {
            if (!isset($views[$key])) {
                if ($required) {
                    throw new ApiError('invalidView');
                }
                continue;
            }
            $view = $views[$key];
            foreach (['position', 'target'] as $vector) {
                if (!isset($view[$vector]) || !is_array($view[$vector]) || count($view[$vector]) !== 3) {
                    throw new ApiError('invalidView');
                }
                foreach ($view[$vector] as $number) {
                    if (!is_numeric($number) || !is_finite((float)$number) || abs((float)$number) > 100000) {
                        throw new ApiError('invalidView');
                    }
                }
                $out[$key][$vector] = array_map('floatval', array_values($view[$vector]));
            }
            if ($out[$key]['position'] === $out[$key]['target']) {
                throw new ApiError('invalidView');
            }
            $span = $view['span'] ?? 20;
            if (!is_numeric($span) || !is_finite((float)$span) || $span <= 0 || $span > 100000) {
                throw new ApiError('invalidView');
            }
            $out[$key]['span'] = (float)$span;
            $out[$key]['mode'] = $key === 'top' ? 'top' : (($view['mode'] ?? '') === 'iso' ? 'iso' : 'perspective');
        }
        return $out;
    }

    private function structure(array $row, string $kind, array $floorIds, array $assets): array
    {
        $id = self::id($row['id'] ?? null);
        if ($kind === 'areas') {
            $floorId = self::id($row['floorId'] ?? null);
            if (!in_array($floorId, $floorIds, true)) {
                throw new ApiError('invalidFloor');
            }
            return ['id' => $id, 'name' => self::text($row['name'] ?? null), 'floorId' => $floorId, 'views' => self::views($row['views'] ?? [], true)];
        }
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
                }
                $out[$k] = (float)$row[$k];
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
            }
            $out['placed'] = $row['placed'];
            $out['views'] = self::views($row['views'] ?? []);
            $ids = $row['areaIds'] ?? [];
            if (!is_array($ids) || count($ids) > 100) {
                throw new ApiError('invalidArea');
            }
            $out['areaIds'] = array_values(array_unique(array_map([self::class, 'id'], $ids)));
            if (isset($row['status'])) {
                if (!in_array($row['status'], ['ok', 'problem', 'retired'], true)) {
                    throw new ApiError('invalidStatus');
                }
                $out['status'] = $row['status'];
            }
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
        $unsignedLink = $this->human && in_array($p['action'] ?? '', ['putLink', 'deleteLink'], true);
        if (!$unsignedLink) {
            self::signature($p['signature'] ?? null);
        }
        self::id($p['requestId'] ?? null);
        return $this->locked(function () use ($p, $unsignedLink) {
            $c = $this->read('catalog.json');
            $c['areas'] ??= [];
            if ($retry = $this->retry($c, $p)) {
                return $retry;
            }
            $action = $p['action'] ?? '';
            $sig = $unsignedLink ? '' : self::signature($p['signature']);
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
                    if (!in_array($kind, ['exhibits','floors','areas'], true)) {
                        throw new ApiError('invalidInput');
                    }
                    $id = self::id($ch['id'] ?? ($ch['record']['id'] ?? null));
                    if (isset($seen[$kind . $id])) {
                        throw new ApiError('invalidInput');
                    }
                    $seen[$kind . $id] = true;
                    $old = isset($c[$kind][$id]) ? $this->record($c[$kind][$id]) : null;
                    if ($op === 'restore') {
                        if ($kind !== 'exhibits' || $old || !isset($c['trash'][$id])) {
                            throw new ApiError('conflict', 409);
                        }
                        $new = $this->record($c['trash'][$id]);
                        $old = $new;
                        if (isset($ch['record'])) {
                            $struct = $this->structure($ch['record'], $kind, $floorIds, $c['assets']);
                            if ($struct['id'] !== $id) {
                                throw new ApiError('invalidId');
                            }
                            $new = array_replace($new, $struct);
                        }
                        if (!in_array($new['floorId'], $floorIds, true)) {
                            throw new ApiError('invalidFloor');
                        }
                        if ($new['status'] !== $old['status']) {
                            $new['statusChanged'] = ['signature' => $sig, 'at' => $now];
                        }
                        unset($new['deleted']);
                        $new['revision']++;
                        $c['exhibits'][$id] = $this->stage('exhibits', $new, $commit);
                        unset($c['trash'][$id]);
                    } elseif ($op === 'delete') {
                        if (!in_array($kind, ['exhibits', 'areas'], true) || !$old) {
                            throw new ApiError('invalidInput');
                        }
                        $this->checkRevision($old, $ch['baseRevision'] ?? null);
                        $new = $old;
                        $new['revision']++;
                        $new['deleted'] = ['signature' => $sig,'at' => $now];
                        if ($kind === 'exhibits') {
                            $c['trash'][$id] = $this->stage('trash', $new, $commit);
                        }
                        unset($c[$kind][$id]);
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
                            $this->assignContentFolder($c, $new);
                            $status = $struct['status'] ?? $ch['status'] ?? null;
                            if (!in_array($status, ['ok','problem','retired'], true)) {
                                throw new ApiError('invalidStatus');
                            }
                            $new += ['status' => $status,'statusChanged' => ['signature' => $sig,'at' => $now],'notes' => [],'links' => []];
                        }
                        if ($kind === 'exhibits' && $old && $new['status'] !== $old['status']) {
                            $new['statusChanged'] = ['signature' => $sig, 'at' => $now];
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
                foreach ($c['exhibits'] as $ref) {
                    $exhibit = $this->record($ref);
                    foreach ($exhibit['areaIds'] ?? [] as $areaId) {
                        if (!isset($c['areas'][$areaId]) || $this->record($c['areas'][$areaId])['floorId'] !== $exhibit['floorId']) {
                            throw new ApiError('invalidArea');
                        }
                    }
                }
                if (!$actions) {
                    return ['saved' => true,'unchanged' => true,'snapshot' => $this->snapshotFrom($c)];
                }
                $c['structureRevision']++;
                $log = ['changeSetId' => $commit,'at' => $now,'signature' => $sig,'baseRevision' => $p['baseRevision'],'resultRevision' => $c['structureRevision'],'actions' => $actions];
            } elseif (in_array($action, ['note','status','links','correctNote','deleteNote','putLink','deleteLink'], true)) {
                $id = self::id($p['exhibitId'] ?? null);
                if (!isset($c['exhibits'][$id])) {
                    throw new ApiError('notFound', 404);
                }
                $r = $this->record($c['exhibits'][$id]);
                if ($action !== 'note') {
                    $this->checkRevision($r, $p['baseRevision'] ?? null);
                } elseif (isset($p['status']) && ($p['baseRevision'] ?? null) !== $r['revision']) {
                    throw new ApiError('conflict', 409, ['current' => $r]);
                }
                if ($this->human && in_array($action, ['correctNote','deleteNote','putLink','deleteLink'], true) && ($p['contentTag'] ?? null) !== $r['contentTag']) {
                    throw new ApiError('conflict', 409, ['current' => $r]);
                }
                if ($action === 'putLink' || $action === 'deleteLink') {
                    if ($action === 'putLink') {
                        $this->human->putLink(
                            $r,
                            isset($p['linkId']) ? self::id($p['linkId']) : null,
                            self::text($p['title'] ?? null),
                            self::url($p['url'] ?? null),
                            self::text($p['description'] ?? '', 1000, false)
                        );
                    } else {
                        $this->human->deleteLink($r, self::id($p['linkId'] ?? null));
                    }
                    $r['revision']++;
                    $c['exhibits'][$id] = $this->stage('exhibits', $r, $commit);
                } else {
                    if ($action === 'deleteNote') {
                        $found = false;
                        foreach ($r['notes'] as &$note) {
                            if ($note['id'] !== ($p['noteId'] ?? null)) {
                                continue;
                            }
                            if (isset($note['deleted'])) {
                                throw new ApiError('noteDeleted', 409);
                            }
                            $note['deleted'] = ['signature' => $sig, 'at' => $now];
                            $found = true;
                        }
                        unset($note);
                        if (!$found) {
                            throw new ApiError('notFound', 404);
                        }
                    }
                    if ($action === 'note' || $action === 'correctNote') {
                        $body = self::text($p['body'] ?? '', 50000, false);
                        $images = $p['images'] ?? [];
                        if (!is_array($images) || count($images) > 8) {
                            throw new ApiError('invalidImage');
                        }
                        foreach ($images as $image) {
                            self::id($image);
                            if ($this->human) {
                                $this->human->photo($image);
                            } elseif (!file_exists($this->path('blobs/' . $image . '.json'))) {
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
                                    if (isset($n['deleted'])) {
                                        throw new ApiError('noteDeleted', 409);
                                    }
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
                        if ($this->human) {
                            throw new ApiError('invalidInput');
                        }
                        if (!is_array($p['links'] ?? null) || count($p['links']) > 100) {
                            throw new ApiError('invalidInput');
                        }
                        $links = [];
                        $ids = [];
                        foreach ($p['links'] as $link) {
                            $lid = self::id($link['id'] ?? null);
                            if (isset($ids[$lid])) {
                                throw new ApiError('invalidId');
                            }
                            $ids[$lid] = true;
                            $links[] = ['id' => $lid,'title' => self::text($link['title'] ?? null),'url' => self::url($link['url'] ?? null),'description' => self::text($link['description'] ?? '', 1000, false),'signature' => $sig,'at' => $now];
                        }
                        $r['links'] = $links;
                    }
                    if ($this->human && in_array($action, ['note','correctNote','deleteNote'], true)) {
                        $before = null;
                        if ($action !== 'note') {
                            $before = $this->record($c['exhibits'][$id]);
                            $before = current(array_filter($before['notes'], fn($note) => $note['id'] === $p['noteId']));
                        }
                        $target = $action === 'note' ? $r['notes'][0] : null;
                        if ($target === null) {
                            foreach ($r['notes'] as $note) {
                                if ($note['id'] === ($p['noteId'] ?? null)) {
                                    $target = $note;
                                    break;
                                }
                            }
                        }
                        $this->human->saveNote($r, $action, $target, $sig);
                        if ($before !== null && $before !== false) {
                            $updated = $this->human->read($r);
                            foreach ($updated['notes'] as $note) {
                                if ($note['id'] !== $p['noteId']) {
                                    continue;
                                }
                                $corrections = $before['corrections'] ?? [];
                                $corrections[] = ['signature' => $sig, 'at' => $now, 'previousBody' => $before['body'], 'previousImages' => $before['images']];
                                $this->atomic('note-meta/' . $note['id'] . '.json', $this->encode(['fileHash' => $note['fileHash'], 'corrections' => $corrections]));
                                break;
                            }
                        }
                    }
                    $r['revision']++;
                    $c['exhibits'][$id] = $this->resourceLock($id, fn()=>$this->stage('exhibits', $r, $commit));
                }
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
            }
            foreach ($dims as $v) {
                if (!is_numeric($v) || !is_finite((float)$v) || $v < 0 || $v > 100000) {
                    throw new ApiError('invalidModel');
                }
            }
        } else {
            throw new ApiError('invalidInput');
        }
        if ($this->human) {
            return $this->locked(function () use ($p, $id, $sig, $bytes, $kind, $mime, $dims) {
                $c = $this->read('catalog.json');
                if ($kind === 'image') {
                    $exhibitId = self::id($p['exhibitId'] ?? null);
                    if (!isset($c['exhibits'][$exhibitId])) {
                        throw new ApiError('notFound', 404);
                    }
                    $receipt = 'blobs/' . $id . '.json';
                    if (file_exists($this->path($receipt))) {
                        $saved = $this->read($receipt);
                        if (($saved['hash'] ?? null) !== hash('sha256', $bytes)) {
                            throw new ApiError('requestConflict', 409);
                        }
                        return ['id' => $saved['id'], 'url' => 'api.php?action=asset&kind=image&id=' . $saved['id']];
                    }
                    $record = $this->record($c['exhibits'][$exhibitId]);
                    $photo = $this->human->savePhoto($record, $sig, $bytes, $mime);
                    $this->atomic($receipt, $this->encode(['id' => $photo['id'], 'name' => $photo['name'], 'hash' => hash('sha256', $bytes)]));
                    return ['id' => $photo['id'], 'url' => 'api.php?action=asset&kind=image&id=' . $photo['id']];
                }
                if (!isset($c['assets'][$id])) {
                    $file = $this->human->saveModel($id, self::text($p['name'] ?? 'Model'), $bytes);
                    $c['assets'][$id] = ['id' => $id, 'name' => self::text($p['name'] ?? 'Model'), 'file' => $file, 'url' => 'api.php?action=asset&kind=model&id=' . $id, 'dimensions' => $dims, 'source' => 'upload'];
                    $c['revision']++;
                    $this->publish($c, null);
                }
                return ['id' => $id, 'url' => 'api.php?action=asset&kind=model&id=' . $id];
            });
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
        if ($this->human) {
            return $this->locked(function () use ($kind, $id) {
                if ($kind === 'image') {
                    return $this->human->photo($id);
                }
                if ($kind !== 'model') {
                    throw new ApiError('notFound', 404);
                }
                $catalog = $this->read('catalog.json');
                $asset = $catalog['assets'][$id] ?? null;
                if (!$asset) {
                    throw new ApiError('notFound', 404);
                }
                $file = $asset['file'] ?? $this->seed['assets'][$id]['file'] ?? null;
                if ($file === null) {
                    throw new ApiError('notFound', 404);
                }
                return $this->human->model($file);
            });
        }
        $folder = match ($kind) {
            'model'=>'models','image'=>'blobs',default=>throw new ApiError('notFound', 404)
        };
        return $this->locked(function () use ($folder, $id) {
            if (!file_exists($this->path("$folder/$id.json"))) {
                throw new ApiError('notFound', 404);
            }
            $m = $this->read("$folder/$id.json");
            return ['path' => $this->path("$folder/$id.bin"),'mime' => $m['mime']];
        });
    }

    public function namedPhoto(string $exhibitId, string $filename): array
    {
        $exhibitId = self::id($exhibitId);
        if (!$this->human) {
            throw new ApiError('notFound', 404);
        }
        return $this->locked(function () use ($exhibitId, $filename) {
            $catalog = $this->read('catalog.json');
            if (!isset($catalog['exhibits'][$exhibitId])) {
                throw new ApiError('notFound', 404);
            }
            return $this->human->namedPhoto($this->record($catalog['exhibits'][$exhibitId]), $filename);
        });
    }
}
