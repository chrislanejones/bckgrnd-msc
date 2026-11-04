<?php

declare(strict_types=1);

namespace App\Support\Project;

use App\Support\Music\ArrangedTrack;
use App\Support\Music\NoteEvent;

/**
 * Patterns, as PHP reads them (project version 3).
 *
 * Mirrors `frontend/lib/patterns.ts`, error text included; `tests/Unit/ContractTest`
 * and `tools/check-contract.mjs` hold both to the same fixtures. The rules:
 *
 * - A lane missing from `patterns` plays the factory lane; a lane present with no
 *   events plays nothing. An empty pattern is silence, never "missing".
 * - Positions are sixteenths of the 16-bar song (`step` 0..255); a note's `len` is in
 *   sixteenths and ends by step 256.
 * - Every event has a stable id, unique in its pattern.
 * - Nothing is flattened: chords keep every pitch, notes keep length, velocity and
 *   accent.
 * - A malformed pattern is refused whole.
 */
final class Patterns
{
    private const ID = '/^[A-Za-z0-9_-]{1,64}$/';

    private const EVENT_ID = '/^[A-Za-z0-9_-]{1,24}$/';

    /** @var array<string, mixed>|null */
    private static ?array $registry = null;

    /**
     * @return array<string, mixed>
     */
    public static function registry(): array
    {
        if (self::$registry === null) {
            $path = dirname(__DIR__, 3).'/contracts/patterns.json';
            self::$registry = json_decode((string) file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
        }

        return self::$registry;
    }

    /**
     * Lane ids in registry order.
     *
     * @return list<string>
     */
    public static function laneIds(): array
    {
        return array_column(self::registry()['lanes'], 'id');
    }

    /**
     * @return array<string, mixed>
     */
    public static function lane(string $id): array
    {
        foreach (self::registry()['lanes'] as $lane) {
            if ($lane['id'] === $id) {
                return $lane;
            }
        }

        throw new \InvalidArgumentException("unknown lane {$id}");
    }

    private static function fail(string $where, string $why): never
    {
        throw new \InvalidArgumentException("Patterns are malformed: {$where}: {$why}");
    }

    private static function isNumber(mixed $v): bool
    {
        return (is_int($v) || is_float($v)) && is_finite((float) $v);
    }

    /**
     * Read one pattern strictly; events come back sorted by step.
     *
     * @return array<string, mixed>
     */
    public static function readPattern(mixed $raw, string $lane, string $where): array
    {
        $steps = (int) self::registry()['steps'];
        $spec = null;
        foreach (self::registry()['lanes'] as $l) {
            if ($l['id'] === $lane) {
                $spec = $l;
            }
        }
        if ($spec === null) {
            self::fail($where, 'unknown lane '.json_encode($lane));
        }
        $at = "{$where} {$lane}";
        if (! is_array($raw) || ($raw !== [] && array_is_list($raw))) {
            self::fail($at, 'expected an object');
        }
        $allowed = ['id', 'revision', 'lane', 'length', 'events', 'origin'];
        $extra = array_values(array_diff(array_keys($raw), $allowed));
        if ($extra !== []) {
            self::fail($at, 'unknown keys '.json_encode($extra));
        }
        foreach (['id', 'revision', 'lane', 'length', 'events'] as $k) {
            if (! array_key_exists($k, $raw)) {
                self::fail($at, "missing {$k}");
            }
        }
        if (! is_string($raw['id']) || ! preg_match(self::ID, $raw['id'])) {
            self::fail($at, 'id must be 1 to 64 letters, digits, - or _');
        }
        if (! is_int($raw['revision']) || $raw['revision'] < 1) {
            self::fail($at, 'revision must be a whole number of at least 1');
        }
        if ($raw['lane'] !== $lane) {
            self::fail($at, "is stored under {$lane} but says ".json_encode($raw['lane']));
        }
        if ($raw['length'] !== $steps) {
            self::fail($at, "length must be {$steps}");
        }
        if (! is_array($raw['events']) || ! array_is_list($raw['events'])) {
            self::fail($at, 'events must be a list');
        }
        $max = (int) self::registry()['maxEvents'];
        if (count($raw['events']) > $max) {
            self::fail($at, "more than {$max} events");
        }
        $maxNotes = (int) self::registry()['maxNotes'];
        $pitch = self::registry()['pitch'];
        $ids = [];
        $seenSteps = [];
        $events = [];
        foreach ($raw['events'] as $i => $e) {
            $w = "{$at} event {$i}";
            if (! is_array($e) || ($e !== [] && array_is_list($e))) {
                self::fail($w, 'expected an object');
            }
            $keys = $spec['kind'] === 'drum' ? ['id', 'step', 'vel'] : ['id', 'step', 'notes', 'len', 'vel', 'accent'];
            $present = array_keys($e);
            if (count($present) !== count($keys) || array_diff($keys, $present) !== []) {
                self::fail($w, 'must have exactly '.implode(', ', $keys));
            }
            if (! is_string($e['id']) || ! preg_match(self::EVENT_ID, $e['id'])) {
                self::fail($w, 'id must be 1 to 24 letters, digits, - or _');
            }
            if (isset($ids[$e['id']])) {
                self::fail($w, "repeats id {$e['id']}");
            }
            $ids[$e['id']] = true;
            if (! is_int($e['step']) || $e['step'] < 0 || $e['step'] >= $steps) {
                self::fail($w, 'step must be a whole number from 0 to '.($steps - 1));
            }
            if (isset($seenSteps[$e['step']])) {
                self::fail($w, "a second event on step {$e['step']}");
            }
            $seenSteps[$e['step']] = true;
            if (! self::isNumber($e['vel']) || $e['vel'] <= 0 || $e['vel'] > 1) {
                self::fail($w, 'vel must be above 0 and at most 1');
            }
            if ($spec['kind'] === 'drum') {
                $events[] = ['id' => $e['id'], 'step' => $e['step'], 'vel' => $e['vel']];

                continue;
            }
            $notes = $e['notes'];
            if (! is_array($notes) || ! array_is_list($notes) || count($notes) < 1 || count($notes) > $maxNotes) {
                self::fail($w, "notes must hold 1 to {$maxNotes} pitches");
            }
            foreach ($notes as $n) {
                if (! self::isNumber($n) || $n < $pitch['min'] || $n > $pitch['max']) {
                    self::fail($w, "every pitch must be from {$pitch['min']} to {$pitch['max']}");
                }
            }
            if (! self::isNumber($e['len']) || $e['len'] <= 0 || $e['step'] + $e['len'] > $steps) {
                self::fail($w, "len must be above 0 and end by step {$steps}");
            }
            if (! is_bool($e['accent'])) {
                self::fail($w, 'accent must be true or false');
            }
            $events[] = [
                'id' => $e['id'],
                'step' => $e['step'],
                'notes' => array_values($notes),
                'len' => $e['len'],
                'vel' => $e['vel'],
                'accent' => $e['accent'],
            ];
        }
        usort($events, static fn (array $a, array $b): int => $a['step'] <=> $b['step']);
        $out = [
            'id' => $raw['id'],
            'revision' => $raw['revision'],
            'lane' => $lane,
            'length' => $steps,
            'events' => $events,
        ];
        if (array_key_exists('origin', $raw)) {
            $o = $raw['origin'];
            $kinds = self::registry()['originKinds'];
            if (! is_array($o) || ($o !== [] && array_is_list($o)) || ! is_string($o['kind'] ?? null) || ! in_array($o['kind'], $kinds, true)) {
                self::fail($at, 'origin must be an object whose kind is one of '.implode(', ', $kinds));
            }
            $out['origin'] = $o;
        }

        return $out;
    }

    private static function isEmptyMap(mixed $v): bool
    {
        return $v === [] || (is_object($v) && get_object_vars($v) === []);
    }

    /**
     * A project's `patterns`, lane to pattern, in registry order.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function readPatterns(mixed $raw, string $where = 'patterns'): array
    {
        if ($raw === null || self::isEmptyMap($raw)) {
            return [];
        }
        if (! is_array($raw) || array_is_list($raw)) {
            self::fail($where, 'expected an object of lanes');
        }
        $lanes = self::laneIds();
        foreach (array_keys($raw) as $key) {
            if (! in_array($key, $lanes, true)) {
                self::fail($where, 'unknown lane '.json_encode($key));
            }
        }
        $out = [];
        foreach ($lanes as $lane) {
            if (array_key_exists($lane, $raw)) {
                $out[$lane] = self::readPattern($raw[$lane], $lane, $where);
            }
        }

        return $out;
    }

    /**
     * A scene's `patterns`: each lane a pinned pattern or `{"factory": true}`.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function readScenePatterns(mixed $raw, string $slot): array
    {
        $where = "slot {$slot} patterns";
        if ($raw === null || self::isEmptyMap($raw)) {
            return [];
        }
        if (! is_array($raw) || array_is_list($raw)) {
            self::fail($where, 'expected an object of lanes');
        }
        $lanes = self::laneIds();
        foreach (array_keys($raw) as $key) {
            if (! in_array($key, $lanes, true)) {
                self::fail($where, 'unknown lane '.json_encode($key));
            }
        }
        $out = [];
        foreach ($lanes as $lane) {
            if (! array_key_exists($lane, $raw)) {
                continue;
            }
            $v = $raw[$lane];
            if (is_array($v) && array_key_exists('factory', $v)) {
                if (count($v) !== 1 || $v['factory'] !== true) {
                    self::fail("{$where} {$lane}", 'a factory reference is exactly {"factory": true}');
                }
                $out[$lane] = ['factory' => true];
            } else {
                $out[$lane] = self::readPattern($v, $lane, $where);
            }
        }

        return $out;
    }

    /**
     * `locks`: locked lanes in registry order, locked event ids per lane, sorted.
     *
     * @return array{lanes: list<string>, events: array<string, list<string>>}
     */
    public static function readLocks(mixed $raw): array
    {
        $where = 'locks';
        if ($raw === null) {
            return ['lanes' => [], 'events' => []];
        }
        if (! is_array($raw) || ($raw !== [] && array_is_list($raw))) {
            self::fail($where, 'expected an object with lanes and events');
        }
        $keys = array_keys($raw);
        if (count($keys) !== 2 || ! in_array('lanes', $keys, true) || ! in_array('events', $keys, true)) {
            self::fail($where, 'must have exactly lanes and events');
        }
        if (! is_array($raw['lanes']) || ! array_is_list($raw['lanes'])) {
            self::fail($where, 'lanes must be a list');
        }
        $all = self::laneIds();
        foreach ($raw['lanes'] as $l) {
            if (! in_array($l, $all, true)) {
                self::fail($where, 'unknown lane '.json_encode($l));
            }
        }
        $lanes = array_values(array_filter($all, static fn (string $l): bool => in_array($l, $raw['lanes'], true)));
        $given = $raw['events'];
        if (! self::isEmptyMap($given) && (! is_array($given) || array_is_list($given))) {
            self::fail($where, 'events must be an object of lanes');
        }
        $given = is_array($given) ? $given : [];
        foreach (array_keys($given) as $key) {
            if (! in_array($key, $all, true)) {
                self::fail($where, 'unknown lane '.json_encode($key));
            }
        }
        $events = [];
        foreach ($all as $lane) {
            if (! array_key_exists($lane, $given)) {
                continue;
            }
            $ids = $given[$lane];
            if (! is_array($ids) || ! array_is_list($ids)) {
                self::fail($where, "events {$lane} must be a list");
            }
            foreach ($ids as $id) {
                if (! is_string($id) || ! preg_match(self::EVENT_ID, $id)) {
                    self::fail($where, "events {$lane} has a bad id");
                }
            }
            $unique = array_values(array_unique($ids));
            sort($unique, SORT_STRING);
            if ($unique !== []) {
                $events[$lane] = $unique;
            }
        }

        return ['lanes' => $lanes, 'events' => $events];
    }

    // ---- The factory -------------------------------------------------------------

    public static function factoryEventId(string $lane, int $step): string
    {
        return self::lane($lane)['prefix'].$step;
    }

    /**
     * A lane as the track wrote it, as a pattern: identity `factory-<lane>`, revision 1.
     * Mirrors `factoryPattern()` in the UI.
     *
     * @return array<string, mixed>
     */
    public static function factory(ArrangedTrack $track, string $lane): array
    {
        $spec = self::lane($lane);
        $steps = (int) self::registry()['steps'];
        $events = [];
        if ($spec['kind'] === 'drum') {
            $field = $lane;
            foreach ($track->{$field} as $step => $v) {
                if ($v > 0 && $step < $steps) {
                    $events[] = ['id' => self::factoryEventId($lane, $step), 'step' => $step, 'vel' => $v];
                }
            }
        } else {
            foreach ($track->{$lane} as $step => $e) {
                if (! $e instanceof NoteEvent || $step >= $steps) {
                    continue;
                }
                $json = $e->jsonSerialize();
                $events[] = [
                    'id' => self::factoryEventId($lane, $step),
                    'step' => $step,
                    'notes' => array_values($json['notes']),
                    'len' => min($json['len'], $steps - $step),
                    'vel' => $json['vel'],
                    'accent' => (bool) $json['accent'],
                ];
            }
        }

        return ['id' => "factory-{$lane}", 'revision' => 1, 'lane' => $lane, 'length' => $steps, 'events' => $events];
    }

    /**
     * A content hash of a lane's events on steps `from..to`, relative to `from`, for
     * matching a static variation to its source. Mirrors `sourceHash()` in the UI:
     * FNV-1a over a canonical text with velocities in thousandths.
     *
     * @param  array<string, mixed>  $pattern
     */
    public static function sourceHash(array $pattern, int $from, int $to): string
    {
        $parts = [];
        foreach ($pattern['events'] as $e) {
            if ($e['step'] < $from || $e['step'] > $to) {
                continue;
            }
            $v = (int) round($e['vel'] * 1000);
            if (array_key_exists('notes', $e)) {
                $notes = implode('.', array_map(static fn ($n): int => (int) round($n), $e['notes']));
                $parts[] = ($e['step'] - $from).":{$v}:{$notes}:".((int) round($e['len'] * 1000)).':'.($e['accent'] ? 1 : 0);
            } else {
                $parts[] = ($e['step'] - $from).":{$v}";
            }
        }
        $text = $pattern['lane'].'|'.implode(',', $parts);
        $h = 0x811C9DC5;
        $len = strlen($text);
        for ($i = 0; $i < $len; $i++) {
            $h ^= ord($text[$i]);
            $h = ($h * 0x01000193) & 0xFFFFFFFF;
        }

        return str_pad(dechex($h), 8, '0', STR_PAD_LEFT);
    }
}
