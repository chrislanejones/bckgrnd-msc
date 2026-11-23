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

    /**
     * The oldest musical version a snapshot may hold. Snapshots arrived with project
     * version 3 (Night 6); bare v1/v2 project files still open through Contract::migrate().
     */
    public const OLDEST_SNAPSHOT_PROJECT = 3;

    /**
     * A stored project as the current version states it, reading and repairing
     * nothing: v3 -> v4 only says `crash: false` on every scene (ADR-023). Mirrors
     * `asCurrentVersion()` in frontend/lib/snapshot.ts.
     *
     * @param  array<string, mixed>  $project
     * @return array<string, mixed>
     */
    public static function asCurrentVersion(array $project): array
    {
        if (($project['version'] ?? null) !== 3 || !is_array($project['scenes']['slots'] ?? null)) return $project;
        $project['version'] = Contract::VERSION;
        foreach ($project['scenes']['slots'] as $i => $slot) {
            if (is_array($slot)) $project['scenes']['slots'][$i]['crash'] = false;
        }
        return $project;
    }

    public static function validate(array $s): void
    {
        $version = $s['project']['version'] ?? null;
        if (is_int($version) && $version > Contract::VERSION) {
            throw new RuntimeException("Project version {$version} is newer than this app understands (".Contract::VERSION.'). Keep the original file and use a newer app.');
        }
        if (($s['format'] ?? '') !== 'bckgrnd-msc/snapshot' || ($s['version'] ?? 0) !== 1
            || ($s['renderer'] ?? '') !== 'project-renderer-1'
            || !is_string($s['id'] ?? null) || !preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $s['id'])
            || !is_int($s['revision'] ?? null) || $s['revision'] < 1
            || !is_int($version) || $version < self::OLDEST_SNAPSHOT_PROJECT) {
            throw new RuntimeException('Unsupported or malformed project snapshot.');
        }
        if (array_diff(array_keys($s), ['format', 'version', 'id', 'revision', 'savedAt', 'renderer', 'source', 'project'])
            || !is_string($s['savedAt'] ?? null) || strtotime($s['savedAt']) === false
            || ($s['source']['trackId'] ?? null) !== ($s['project']['trackId'] ?? null)
            || !preg_match('/^[a-f0-9]{64}$/D', $s['source']['sha256'] ?? '')
            || array_diff(array_keys($s['source']), ['trackId', 'sha256'])) throw new RuntimeException('Malformed snapshot metadata.');
        // Canonical, complete documents only: an older one is held to the same check after
        // the one step its migration states, so nothing is clamped or dropped quietly.
        $normalized = json_decode(json_encode(Contract::migrate($s['project']), JSON_THROW_ON_ERROR), true);
        if ($normalized != self::asCurrentVersion($s['project'])) throw new RuntimeException('Project contains invalid values or unsupported fields.');
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
            // Revisions this write doesn't replace are kept exactly as stored, decoded as
            // objects so `{}` stays `{}`: an older (v3) revision is never rewritten as v4
            // behind the user's back, only the snapshot being written is current.
            $stored = is_file($path) ? json_decode(file_get_contents($path), false, flags: JSON_THROW_ON_ERROR) : null;
            $record = $stored instanceof \stdClass ? get_object_vars($stored) : [];
            $revision = static fn (mixed $entry): int => is_object($entry) ? (int) ($entry->revision ?? 0) : (int) ($entry['revision'] ?? 0);
            if ($expected === null) {
                if (max($revision($record['current'] ?? null), $revision($record['recovery'] ?? null)) >= $snapshot['revision']) return;
                $record['recovery'] = $snapshot;
            } else {
                if ($revision($record['current'] ?? null) !== $expected || $snapshot['revision'] < $expected) throw new RuntimeException('This project changed in another window. Save As to preserve both versions.');
                if (isset($record['current'])) $record['previous'] = $record['current'];
                $record['current'] = $snapshot;
                if ($revision($record['recovery'] ?? null) <= $snapshot['revision']) unset($record['recovery']);
            }
            self::atomicWrite($path, json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Write a project out where the person asked for it, keeping what was there as .bak. */
    public static function saveFile(string $path, array $snapshot): void
    {
        $snapshot['project'] = Contract::migrate($snapshot['project']);
        // A symlinked project file is updated where it points, never replaced by a copy.
        if (is_link($path) && ($target = realpath($path)) !== false) $path = $target;
        if (is_file($path) && !copy($path, $path.'.bak')) throw new RuntimeException('Cannot back up the existing project file.');
        self::writeChosenFile($path, json_encode($snapshot, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    }

    /**
     * Write a file at a place the person chose (a project file, a WAV export). A new
     * file gets ordinary permissions, not the temp file's 0600; an existing one keeps
     * its own; a symlink is updated where it points. The app's store stays private.
     */
    public static function writeChosenFile(string $path, string $bytes): void
    {
        if (is_link($path) && ($target = realpath($path)) !== false) $path = $target;
        self::atomicWrite($path, $bytes, is_file($path) ? null : 0666 & ~umask());
    }

    /** Save As ties a project to its file, so a later Save can keep that file current. */
    public function linkFile(string $id, string $path): void
    {
        $this->changeLinks(function (array $links) use ($id, $path) { $links[$id] = $path; return $links; });
    }

    public function linkedFile(string $id): ?string
    {
        $path = $this->linksPath();
        if (!is_file($path)) return null;
        return json_decode(file_get_contents($path), true, flags: JSON_THROW_ON_ERROR)[$id] ?? null;
    }

    /** The file written, or null when this project was never saved as a file. */
    public function updateLinkedFile(array $snapshot): ?string
    {
        self::validate($snapshot);
        $path = $this->linkedFile($snapshot['id']);
        if ($path === null) return null;
        if (!is_file($path)) throw new RuntimeException("It's no longer at {$path}. Use Save As to choose a new place.");
        self::saveFile($path, $snapshot);
        return $path;
    }

    private function linksPath(): string
    {
        // Dotted, so records() can't read it as a project. Project IDs never contain a dot.
        return $this->root.'/.file-links.json';
    }

    private function changeLinks(callable $change): void
    {
        if (!is_dir($this->root) && !mkdir($this->root, 0700, true) && !is_dir($this->root)) throw new RuntimeException('Cannot create project storage.');
        $path = $this->linksPath();
        $lock = fopen($path.'.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Cannot lock project storage.');
        try {
            $links = is_file($path) ? json_decode(file_get_contents($path), true, flags: JSON_THROW_ON_ERROR) : [];
            self::atomicWrite($path, json_encode((object) $change($links), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * Replace $path with $bytes, or leave it untouched. An existing file keeps its
     * permissions; a new one gets $mode, or tempnam's private 0600 when none is given.
     */
    public static function atomicWrite(string $path, string $bytes, ?int $mode = null): void
    {
        $temp = tempnam(dirname($path), '.bckgrnd-');
        if (!$temp) throw new RuntimeException('Cannot create a temporary output file.');
        try {
            $keep = is_file($path) ? fileperms($path) & 0777 : $mode;
            if ($keep !== null && !chmod($temp, $keep)) throw new RuntimeException('Cannot set output file permissions.');
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
        // The file itself stays; it was only the link that belonged to the app.
        if ($this->linkedFile($id) !== null) $this->changeLinks(function (array $links) use ($id) { unset($links[$id]); return $links; });
    }
}
