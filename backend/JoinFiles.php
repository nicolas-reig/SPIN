<?php

declare(strict_types=1);

final class JoinFiles
{
    private array $used = [];

    public function __construct(private readonly Files $files)
    {
    }

    private static function scan(string $root, string $relative = ''): array
    {
        $path = $root . ($relative === '' ? '' : '/' . $relative);
        if (is_link($path)) throw new ApiError('invalidPath');
        $entries = scandir($path);
        if ($entries === false) throw new ApiError('storage', 503);
        $result = ['directories' => [], 'files' => []];
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') continue;
            $next = $relative === '' ? $name : $relative . '/' . $name;
            $file = $root . '/' . $next;
            if (is_link($file)) throw new ApiError('invalidPath');
            if ($next === '.exhibit.json' && is_file($file)) continue;
            if (is_dir($file)) {
                $result['directories'][] = $next;
                $children = self::scan($root, $next);
                $result['directories'] = array_merge($result['directories'], $children['directories']);
                $result['files'] += $children['files'];
            } elseif (is_file($file)) $result['files'][$next] = $file;
            else throw new ApiError('invalidPath');
        }
        return $result;
    }

    private function reserve(string $folder, string $name): void
    {
        $this->used[$folder][mb_strtolower($name, 'UTF-8')] = $name;
        $dated = HumanFiles::datedFilename($name);
        if ($dated) {
            $canonical = $dated['author'] . ' ' . $dated['when']->format('d_m_Y H.i') . '.' . $dated['extension'];
            $this->used[$folder][mb_strtolower($canonical, 'UTF-8')] = $name;
        }
    }

    private function names(string $folder): array
    {
        if (!isset($this->used[$folder])) {
            $this->used[$folder] = [];
            $names = scandir($folder);
            if ($names === false) throw new ApiError('storage', 503);
            foreach ($names as $name) if ($name !== '.' && $name !== '..') $this->reserve($folder, $name);
        }
        return $this->used[$folder];
    }

    private function available(string $folder, string $name): string
    {
        $used = $this->names($folder);
        $dated = HumanFiles::datedFilename($name);
        $canonical = $dated ? $dated['author'] . ' ' . $dated['when']->format('d_m_Y H.i') . '.' . $dated['extension'] : $name;
        if (!isset($used[mb_strtolower($name, 'UTF-8')]) && !isset($used[mb_strtolower($canonical, 'UTF-8')])) {
            $this->reserve($folder, $name);
            return $name;
        }
        if ($dated) {
            $when = $dated['when'];
            do {
                $when = $when->modify('+1 minute');
                $candidate = HumanFiles::filename($dated['author'] . ' ' . $when->format('d_m_Y H.i') . '.' . $dated['extension']);
            } while (isset($used[mb_strtolower($candidate, 'UTF-8')]));
        } else {
            $extension = pathinfo($name, PATHINFO_EXTENSION);
            $extension = $extension === '' ? '' : '.' . $extension;
            $stem = $extension === '' ? $name : substr($name, 0, -strlen($extension));
            $number = 2;
            do {
                $suffix = ' (' . $number++ . ')' . $extension;
                $prefix = rtrim(mb_strcut($stem, 0, max(1, 160 - strlen($suffix)), 'UTF-8'), '. ');
                $candidate = ($prefix === '' ? 'File' : $prefix) . $suffix;
            } while (isset($used[mb_strtolower($candidate, 'UTF-8')]));
        }
        $this->reserve($folder, $candidate);
        return $candidate;
    }

    private function directory(string $target, string $relative, bool $root): string
    {
        $path = $target;
        foreach (explode('/', $relative) as $index => $part) {
            $names = $this->names($path);
            $existing = $names[mb_strtolower($part, 'UTF-8')] ?? null;
            if ($existing !== null && is_dir($path . '/' . $existing) && !is_link($path . '/' . $existing)) {
                if ($root && $index === 0 && in_array($part, ['Notizen', 'Fotos', 'Links'], true) && $existing !== $part) {
                    throw new ApiError('invalidPath');
                }
                $part = $existing;
            } else $part = $this->available($path, $part);
            $path .= '/' . $part;
            $this->files->directory($path);
        }
        return $path;
    }

    private static function relative(string $from, string $to): string
    {
        $from = explode('/', trim($from, '/'));
        $to = explode('/', trim($to, '/'));
        while ($from && $to && $from[0] === $to[0]) {
            array_shift($from);
            array_shift($to);
        }
        return implode('/', array_merge(array_fill(0, count($from), '..'), $to));
    }

    private static function encoded(string $path): string
    {
        return implode('/', array_map('rawurlencode', explode('/', $path)));
    }

    private static function caseReferences(array $aliases): array
    {
        $result = [];
        foreach ($aliases as $before => $after) {
            $key = mb_strtolower($before, 'UTF-8');
            $result[$key] = isset($result[$key]) && $result[$key] !== $after ? false : $after;
        }
        return $result;
    }

    private static function rewrite(string $body, array $aliases, ?array $folded = null): string
    {
        $original = $body;
        $footer = '';
        if (preg_match('/\n<!-- edited by ([^\r\n<>]+) -->\s*$/u', $body, $match)) {
            $footer = $match[0];
            $body = substr($body, 0, -strlen($footer));
        }
        if (preg_match('/^deleted by [^\r\n]+\s*$/iu', $body)) return $original;
        $folded ??= self::caseReferences($aliases);
        $url = function (string $value) use ($aliases, $folded): string {
            $angle = str_starts_with($value, '<') && str_ends_with($value, '>');
            $address = $angle ? substr($value, 1, -1) : $value;
            $length = strcspn($address, '?#');
            $path = rawurldecode(html_entity_decode(substr($address, 0, $length), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            $path = preg_replace('~\\\\([[:punct:]])~', '$1', $path);
            if (!mb_check_encoding($path, 'UTF-8')) return $value;
            while (str_starts_with($path, './')) $path = substr($path, 2);
            $destination = $aliases[$path] ?? $folded[mb_strtolower($path, 'UTF-8')] ?? null;
            if (!is_string($destination) || $destination === $path) return $value;
            $replacement = self::encoded($destination) . substr($address, $length);
            return $angle ? '<' . $replacement . '>' : $replacement;
        };
        $pattern = <<<'REGEX'
~(?<inline>!?\[[^\r\n]*?\]\([ \t]*)(?<inlineUrl><[^>\r\n]*>|(?:[^\s()\\]+|\\.|(?<parens>\((?:[^()\\]|\\.|(?&parens))*\)))+)
|(?<reference>^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*)(?<referenceUrl><[^>\r\n]*>|[^\s]+)
|(?<html><(?:img|a)\b(?:[^"'<>]|"[^"]*"|'[^']*')*?\s(?:src|href)\s*=\s*)(?<quote>["'])(?<htmlUrl>[^\r\n]*?)\k<quote>~mux
REGEX;
        $result = preg_replace_callback($pattern, function ($match) use ($url) {
            if (($match['inline'] ?? '') !== '') return $match['inline'] . $url($match['inlineUrl']);
            if (($match['reference'] ?? '') !== '') return $match['reference'] . $url($match['referenceUrl']);
            return $match['html'] . $match['quote'] . $url($match['htmlUrl']) . $match['quote'];
        }, $body);
        if ($result === null) throw new ApiError('invalidInput');
        return $result . $footer;
    }

    public function merge(string $target, string $original, string $final, array $sources): void
    {
        $moves = [];
        $references = [];
        $notes = [];
        $existing = self::scan($target);
        foreach ($existing['files'] as $relative => $path) {
            $references[$original . '/' . $relative] = $final . '/' . $relative;
            if (str_ends_with(mb_strtolower($relative), '.md')) {
                $notes[] = [$path, $original . '/' . $relative, $final . '/' . $relative];
            }
        }
        foreach ($sources as $source) {
            $entries = self::scan($source);
            $directories = ['' => $target];
            foreach ($entries['directories'] as $relative) {
                $parent = dirname($relative);
                $parent = $parent === '.' ? '' : $parent;
                $directories[$relative] = $this->directory($directories[$parent], basename($relative), $parent === '');
            }
            foreach ($entries['files'] as $relative => $path) {
                $folder = dirname($relative);
                $folder = $folder === '.' ? '' : $folder;
                $destination = $directories[$folder] . '/' . $this->available($directories[$folder], basename($relative));
                $newRelative = substr($destination, strlen($target) + 1);
                $references[$source . '/' . $relative] = $final . '/' . $newRelative;
                $moves[] = [$path, $destination];
                if (str_ends_with(mb_strtolower($relative), '.md')) {
                    $notes[] = [$path, $source . '/' . $relative, $final . '/' . $newRelative];
                }
            }
        }
        $aliases = [];
        $folded = [];
        $context = null;
        foreach ($notes as [$path, $old, $new]) {
            $key = dirname($old) . "\n" . dirname($new);
            if ($context !== $key) {
                $context = $key;
                $aliases = [];
                foreach ($references as $before => $after) {
                    $before = self::relative(dirname($old), $before);
                    $after = self::relative(dirname($new), $after);
                    $aliases[$before] = $after;
                }
                $folded = self::caseReferences($aliases);
            }
            $body = file_get_contents($path);
            if ($body === false) throw new ApiError('storage', 503);
            $rewritten = self::rewrite($body, $aliases, $folded);
            if ($body !== $rewritten) {
                $stat = stat($path);
                if (!$stat) throw new ApiError('storage', 503);
                $this->files->write($path, $rewritten);
                if (!touch($path, $stat['mtime'], $stat['atime'])) throw new ApiError('storage', 503);
            }
        }
        foreach ($moves as [$source, $destination]) $this->files->move($source, $destination);
        foreach ($sources as $source) $this->files->removeTree($source);
    }
}
