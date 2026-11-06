<?php

declare(strict_types=1);

namespace App\Support\Project;

use RuntimeException;

/** Native adapter for the same snapshot format used by IndexedDB and MCP. */
final class ProjectFiles
{
    public function __construct(private readonly string $root) {}

    public function records(): array
    {
        $out = [];
        foreach (glob($this->root.'/*.json') ?: [] as $path) {
            $out[] = json_decode(file_get_contents($path), false, flags: JSON_THROW_ON_ERROR);
        }
        return $out;
    }

    public static function validate(array $s): void
    {
        if (($s['format'] ?? '') !== 'bckgrnd-msc/snapshot' || ($s['version'] ?? 0) !== 1
            || ($s['renderer'] ?? '') !== 'project-renderer-1'
            || !is_string($s['id'] ?? null) || !preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $s['id'])
            || !is_int($s['revision'] ?? null) || $s['revision'] < 1
            || ($s['project']['version'] ?? 0) !== 3) {
            throw new RuntimeException('Unsupported or malformed project snapshot.');
        }
        if (array_diff(array_keys($s), ['format', 'version', 'id', 'revision', 'savedAt', 'renderer', 'source', 'project'])
            || !is_string($s['savedAt'] ?? null) || strtotime($s['savedAt']) === false
            || ($s['source']['trackId'] ?? null) !== ($s['project']['trackId'] ?? null)
            || !preg_match('/^[a-f0-9]{64}$/D', $s['source']['sha256'] ?? '')
            || array_diff(array_keys($s['source']), ['trackId', 'sha256'])) throw new RuntimeException('Malformed snapshot metadata.');
        $normalized = json_decode(json_encode(Contract::migrate($s['project']), JSON_THROW_ON_ERROR), true);
        if ($normalized != $s['project']) throw new RuntimeException('Project contains invalid values or unsupported fields.');
    }

    public function write(array $snapshot, ?int $expected): void
    {
        self::validate($snapshot);
        $snapshot['project'] = Contract::migrate($snapshot['project']);
        if (!is_dir($this->root) && !mkdir($this->root, 0700, true) && !is_dir($this->root)) throw new RuntimeException('Cannot create project storage.');
        $path = $this->root.'/'.$snapshot['id'].'.json';
        $lock = fopen($path.'.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Cannot lock project storage.');
        try {
            $record = is_file($path) ? json_decode(file_get_contents($path), true, flags: JSON_THROW_ON_ERROR) : [];
            if ($expected === null) {
                if (max($record['current']['revision'] ?? 0, $record['recovery']['revision'] ?? 0) >= $snapshot['revision']) return;
                $record['recovery'] = $snapshot;
            } else {
                if (($record['current']['revision'] ?? 0) !== $expected || $snapshot['revision'] < $expected) throw new RuntimeException('This project changed in another window. Save As to preserve both versions.');
                if (isset($record['current'])) $record['previous'] = $record['current'];
                $record['current'] = $snapshot;
                if (($record['recovery']['revision'] ?? 0) <= $snapshot['revision']) unset($record['recovery']);
            }
            foreach (['current', 'previous', 'recovery'] as $key) {
                if (isset($record[$key])) $record[$key]['project'] = Contract::migrate(json_decode(json_encode($record[$key]['project']), true));
            }
            self::atomicWrite($path, json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    public static function atomicWrite(string $path, string $bytes): void
    {
        $temp = tempnam(dirname($path), '.bckgrnd-');
        if (!$temp) throw new RuntimeException('Cannot create a temporary output file.');
        try {
            $file = fopen($temp, 'wb');
            if (!$file) throw new RuntimeException('Cannot open output file.');
            try {
                $done = 0;
                while ($done < strlen($bytes)) {
                    $n = fwrite($file, substr($bytes, $done));
                    if (!$n) throw new RuntimeException('Write failed. Previous file preserved.');
                    $done += $n;
                }
                if (!fflush($file) || !fsync($file)) throw new RuntimeException('Cannot confirm output write.');
            } finally { fclose($file); }
            if (!rename($temp, $path)) throw new RuntimeException('Cannot commit output. Previous file preserved.');
        } finally { if (is_file($temp)) unlink($temp); }
    }

    public function remove(string $id): void
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $id)) throw new RuntimeException('Invalid project ID.');
        $path = $this->root.'/'.$id.'.json';
        if (is_file($path) && !unlink($path)) throw new RuntimeException('Cannot delete project.');
    }
}
