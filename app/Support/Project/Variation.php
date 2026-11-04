<?php

declare(strict_types=1);

namespace App\Support\Project;

/**
 * Constrained variation: a new take on part of one lane, never a new song.
 *
 * PHP owns the music, so PHP writes the variations; the browser only previews them.
 * Given the lane as it is now (the *source*), a range of whole bars, a strength and a
 * seed, `generate()` returns one candidate pattern. The rules it keeps:
 *
 * - **Same inputs, same output.** All chance comes from the seed (a 32-bit mulberry
 *   generator), mixed with the lane and the range, so a seed is a name for a result.
 * - **Only the range changes.** Events outside it, and every other lane, are left
 *   exactly as they were.
 * - **Locks hold.** A locked lane is refused; a locked event keeps its step and its
 *   velocity (it can be neither removed nor touched).
 * - **Anchors hold.** The hits that carry the groove (kicks on the beat, claps on the
 *   backbeat, offbeat hats) and the first note of every bar keep their place and
 *   level, whatever the strength.
 * - **Drums vary in rhythm and dynamics.** Ghost hits added or removed on the lane's
 *   own grid, an offbeat lift at Moderate and up, a short flourish into the last beat
 *   of the range, and velocity movement. A closed hat is never added on top of an open
 *   one (or the other way round).
 * - **Melodic lanes vary in rhythm only.** No track records its harmony yet, so a
 *   variation that changed a pitch would be a guess about the key. Notes are nudged,
 *   split, shortened, accented or (at Adventurous) dropped; every pitch, chords
 *   included, is kept. The result says so (`reason`).
 *
 * The result records the generator version, the seed, the strength, the range, the
 * source revision and the source's content hash, so a kept variation can say exactly
 * what made it.
 */
final class Variation
{
    public const GENERATOR = 'php-variation-1';

    /** Strengths and what each allows, per four bars. */
    public const STRENGTHS = [
        'subtle' => ['changes' => 2, 'velocity' => 0.06, 'offbeat' => false, 'flourish' => false, 'drop' => false],
        'moderate' => ['changes' => 4, 'velocity' => 0.1, 'offbeat' => true, 'flourish' => true, 'drop' => false],
        'adventurous' => ['changes' => 7, 'velocity' => 0.16, 'offbeat' => true, 'flourish' => true, 'drop' => true],
    ];

    private const MIN_VELOCITY = 0.02;

    /** What a melodic variation cannot do yet, said where the user chose it. */
    public const RHYTHM_ONLY = 'Rhythm and dynamics only: no track records its harmony yet, so every pitch (chords too) is kept.';

    /**
     * One candidate.
     *
     * @param  array<string, mixed>  $source  a pattern, as `Patterns::readPattern` returns it
     * @param  array{lanes: list<string>, events: array<string, list<string>>}  $locks
     * @param  array<string, array<string, mixed>>  $context  other lanes as they are now (for open/closed hats)
     * @return array<string, mixed> `status` ok (with `candidate`, `mode`, `preserved`, `reason`) or unavailable (with `reason`)
     */
    public static function generate(
        array $source,
        int $from,
        int $to,
        string $strength,
        int $seed,
        array $locks,
        array $context = [],
    ): array {
        $lane = (string) $source['lane'];
        $spec = Patterns::lane($lane);
        if (! ($spec['editable'] ?? false)) {
            return ['status' => 'unavailable', 'reason' => "{$spec['label']} is not editable in this version."];
        }
        if (in_array($lane, $locks['lanes'] ?? [], true)) {
            return ['status' => 'unavailable', 'reason' => "{$spec['label']} is locked."];
        }
        if (! isset(self::STRENGTHS[$strength])) {
            return ['status' => 'unavailable', 'reason' => "Unknown strength {$strength}."];
        }
        if ($from < 0 || $to > 255 || $from % 16 !== 0 || ($to + 1) % 16 !== 0 || $to <= $from) {
            return ['status' => 'unavailable', 'reason' => 'A variation covers whole bars of the song.'];
        }

        $params = self::STRENGTHS[$strength];
        $bars = intdiv($to - $from + 1, 16);
        $changes = max(1, (int) round($params['changes'] * $bars / 4));
        $rand = self::rng(($seed ^ crc32($lane.':'.$from.':'.$to)) & 0xFFFFFFFF);
        $locked = array_flip($locks['events'][$lane] ?? []);

        if ($spec['kind'] === 'drum') {
            [$events, $preserved] = self::drums($source, $spec, $from, $to, $params, $changes, $rand, $locked, $context);
            $mode = 'drums';
            $reason = null;
        } else {
            [$events, $preserved] = self::notes($source, $spec, $from, $to, $params, $changes, $rand, $locked);
            $mode = 'rhythm';
            $reason = self::RHYTHM_ONLY;
        }

        usort($events, fn (array $a, array $b): int => $a['step'] <=> $b['step']);
        $id = str_starts_with((string) $source['id'], 'factory-') ? "p-{$lane}" : (string) $source['id'];

        return [
            'status' => 'ok',
            'generator' => self::GENERATOR,
            'mode' => $mode,
            'reason' => $reason,
            'preserved' => $preserved,
            'candidate' => [
                'id' => $id,
                'revision' => (int) $source['revision'] + 1,
                'lane' => $lane,
                'length' => 256,
                'events' => array_values($events),
                'origin' => [
                    'kind' => 'variation',
                    'generator' => self::GENERATOR,
                    'seed' => $seed,
                    'strength' => $strength,
                    'scope' => ['from' => $from, 'to' => $to],
                    'sourceRevision' => (int) $source['revision'],
                    'sourceHash' => Patterns::sourceHash($source, $from, $to),
                    'mode' => $mode,
                ],
            ],
        ];
    }

    /**
     * Whether a hit on `$col` (0..15 in its bar) holds the groove for this lane.
     */
    private static function anchor(string $lane, int $col): bool
    {
        return match ($lane) {
            'kick' => $col % 4 === 0,
            'clap' => $col === 4 || $col === 12,
            'hat', 'hatOpen' => $col % 4 === 2,
            default => false,
        };
    }

    /** Where this lane may gain a hit: its own grid, wider at Moderate and up. */
    private static function grid(string $lane, int $col, bool $offbeat): bool
    {
        return match ($lane) {
            'kick' => $offbeat ? $col % 2 === 0 || $col % 4 === 3 : $col % 2 === 0,
            'clap' => $offbeat ? $col % 2 === 1 || $col % 4 === 2 : $col % 4 === 2,
            default => $offbeat ? true : $col % 2 === 0,
        };
    }

    /**
     * @return array{0: list<array<string, mixed>>, 1: list<string>}
     */
    private static function drums(
        array $source,
        array $spec,
        int $from,
        int $to,
        array $params,
        int $changes,
        \Closure $rand,
        array $locked,
        array $context,
    ): array {
        $lane = (string) $spec['id'];
        $outside = [];
        $byStep = [];
        foreach ($source['events'] as $e) {
            if ($e['step'] < $from || $e['step'] > $to) {
                $outside[] = $e;
            } else {
                $byStep[$e['step']] = $e;
            }
        }
        // Steps the partner hat lane already plays: a closed hat never lands on an open one.
        $blocked = [];
        $partner = $lane === 'hat' ? 'hatOpen' : ($lane === 'hatOpen' ? 'hat' : null);
        if ($partner !== null && isset($context[$partner])) {
            foreach ($context[$partner]['events'] as $e) {
                $blocked[$e['step']] = true;
            }
        }
        $isFixed = fn (array $e): bool => isset($locked[$e['id']]) || self::anchor($lane, $e['step'] % 16);
        $taken = array_flip(array_map(fn (array $e): string => (string) $e['id'], $source['events']));
        $newId = function () use (&$taken, $spec): string {
            for ($i = 1; ; $i++) {
                $id = $spec['prefix'].'v'.$i;
                if (! isset($taken[$id])) {
                    $taken[$id] = true;

                    return $id;
                }
            }
        };
        $ghost = fn (): float => round((float) $spec['velocity'] * (0.5 + 0.3 * $rand()), 3);

        for ($i = 0; $i < $changes; $i++) {
            $removable = array_values(array_filter($byStep, fn (array $e): bool => ! $isFixed($e)));
            $open = [];
            for ($s = $from; $s <= $to; $s++) {
                if (! isset($byStep[$s]) && ! isset($blocked[$s]) && self::grid($lane, $s % 16, $params['offbeat'])) {
                    $open[] = $s;
                }
            }
            $remove = $removable !== [] && ($open === [] || $rand() < 0.4);
            if ($remove) {
                $e = $removable[(int) floor($rand() * count($removable))];
                unset($byStep[$e['step']]);
            } elseif ($open !== []) {
                $s = $open[(int) floor($rand() * count($open))];
                $byStep[$s] = ['id' => $newId(), 'step' => $s, 'vel' => $ghost()];
            }
        }

        // A lift: at least one hit on an offbeat sixteenth.
        if ($params['offbeat'] && in_array($lane, ['hat', 'clap'], true)) {
            $has = false;
            foreach ($byStep as $s => $e) {
                $has = $has || $s % 2 === 1;
            }
            if (! $has) {
                $cands = [];
                for ($s = $from + 1; $s <= $to; $s += 2) {
                    if (! isset($byStep[$s]) && ! isset($blocked[$s])) {
                        $cands[] = $s;
                    }
                }
                if ($cands !== []) {
                    $s = $cands[(int) floor($rand() * count($cands))];
                    $byStep[$s] = ['id' => $newId(), 'step' => $s, 'vel' => $ghost()];
                }
            }
        }

        // A flourish into the last beat of the range: a short ramp, or a kick pickup.
        if ($params['flourish']) {
            $beat = $to - 3;
            $steps = $lane === 'kick' ? [$beat + 2 + (int) floor($rand() * 2)] : [$beat + 1, $beat + 2, $beat + 3];
            foreach ($steps as $k => $s) {
                if (isset($byStep[$s]) || isset($blocked[$s])) {
                    continue;
                }
                $vel = round((float) $spec['velocity'] * (0.45 + 0.15 * $k), 3);
                $byStep[$s] = ['id' => $newId(), 'step' => $s, 'vel' => $vel];
            }
        }

        // Dynamics: everything that is not fixed moves a little.
        foreach ($byStep as $s => $e) {
            if ($isFixed($e)) {
                continue;
            }
            $v = (float) $e['vel'] * (1 + ($rand() * 2 - 1) * $params['velocity']);
            $byStep[$s]['vel'] = round(min(1.0, max(self::MIN_VELOCITY, $v)), 3);
        }

        $preserved = [match ($lane) {
            'kick' => 'kicks on the beat',
            'clap' => 'backbeat claps',
            default => 'offbeat hats',
        }];
        if ($locked !== []) {
            $preserved[] = 'locked hits';
        }

        return [array_merge($outside, array_values($byStep)), $preserved];
    }

    /**
     * @return array{0: list<array<string, mixed>>, 1: list<string>}
     */
    private static function notes(
        array $source,
        array $spec,
        int $from,
        int $to,
        array $params,
        int $changes,
        \Closure $rand,
        array $locked,
    ): array {
        $events = [];
        foreach ($source['events'] as $e) {
            $events[(string) $e['id']] = $e;
        }
        $taken = array_flip(array_keys($events));
        $newId = function () use (&$taken, $spec): string {
            for ($i = 1; ; $i++) {
                $id = $spec['prefix'].'v'.$i;
                if (! isset($taken[$id])) {
                    $taken[$id] = true;

                    return $id;
                }
            }
        };
        // The first note of each bar stays where it is: it says where the phrase is.
        $firsts = [];
        foreach ($events as $e) {
            $bar = intdiv((int) $e['step'], 16);
            if (! isset($firsts[$bar]) || $e['step'] < $events[$firsts[$bar]]['step']) {
                $firsts[$bar] = (string) $e['id'];
            }
        }
        $anchors = array_flip(array_values($firsts));
        $free = fn (int $step, float $len, ?string $ignore) => self::freeSpan($events, $step, $len, $ignore);

        for ($i = 0; $i < $changes; $i++) {
            $movable = array_values(array_filter(
                $events,
                fn (array $e): bool => $e['step'] >= $from && $e['step'] <= $to
                    && ! isset($locked[$e['id']]) && ! isset($anchors[$e['id']]),
            ));
            if ($movable === []) {
                break;
            }
            $e = $movable[(int) floor($rand() * count($movable))];
            $id = (string) $e['id'];
            $ops = ['nudge', 'split', 'shorten'];
            if ($params['offbeat']) {
                $ops[] = 'accent';
            }
            if ($params['drop']) {
                $ops[] = 'drop';
            }
            $op = $ops[(int) floor($rand() * count($ops))];
            if ($op === 'nudge') {
                $dir = $rand() < 0.5 ? -1 : 1;
                $step = (int) $e['step'] + $dir;
                if ($step >= $from && $step <= $to && $step + $e['len'] <= 256 && $free($step, (float) $e['len'], $id)) {
                    $events[$id]['step'] = $step;
                }
            } elseif ($op === 'split' && $e['len'] >= 2) {
                $a = (float) floor($e['len'] / 2);
                $b = (float) $e['len'] - $a;
                $events[$id]['len'] = $a;
                $nid = $newId();
                $events[$nid] = [
                    'id' => $nid,
                    'step' => (int) $e['step'] + (int) $a,
                    'notes' => $e['notes'],
                    'len' => $b,
                    'vel' => round(max(self::MIN_VELOCITY, (float) $e['vel'] * 0.85), 3),
                    'accent' => false,
                ];
            } elseif ($op === 'shorten' && $e['len'] > 1) {
                $events[$id]['len'] = max(1.0, (float) $e['len'] - 1);
            } elseif ($op === 'accent') {
                $events[$id]['accent'] = ! $e['accent'];
            } elseif ($op === 'drop') {
                unset($events[$id]);
            }
        }

        foreach ($events as $id => $e) {
            if ($e['step'] < $from || $e['step'] > $to || isset($locked[$id]) || isset($anchors[$id])) {
                continue;
            }
            $v = (float) $e['vel'] * (1 + ($rand() * 2 - 1) * $params['velocity']);
            $events[$id]['vel'] = round(min(1.0, max(self::MIN_VELOCITY, $v)), 3);
        }

        $preserved = ['every pitch', 'the first note of each bar'];
        if ($locked !== []) {
            $preserved[] = 'locked notes';
        }

        return [array_values($events), $preserved];
    }

    /** Whether `[step, step + len)` overlaps no note but `$ignore`. */
    private static function freeSpan(array $events, int $step, float $len, ?string $ignore): bool
    {
        foreach ($events as $id => $e) {
            if ((string) $id === $ignore) {
                continue;
            }
            if ($step < $e['step'] + $e['len'] && $e['step'] < $step + $len) {
                return false;
            }
        }

        return true;
    }

    /**
     * Mulberry32: a small 32-bit generator. The same seed gives the same sequence on
     * every machine (PHP's 64-bit integers carry the arithmetic exactly).
     */
    public static function rng(int $seed): \Closure
    {
        $a = $seed & 0xFFFFFFFF;

        return function () use (&$a): float {
            $a = ($a + 0x6D2B79F5) & 0xFFFFFFFF;
            $t = self::imul($a ^ ($a >> 15), $a | 1);
            $t ^= ($t + self::imul($t ^ ($t >> 7), $t | 61)) & 0xFFFFFFFF;

            return (($t ^ ($t >> 14)) & 0xFFFFFFFF) / 4294967296;
        };
    }

    /** 32-bit multiply, as JavaScript's Math.imul (unsigned result). */
    private static function imul(int $a, int $b): int
    {
        $a &= 0xFFFFFFFF;
        $b &= 0xFFFFFFFF;

        return (((((($a >> 16) * $b) & 0xFFFF) << 16)) + (($a & 0xFFFF) * $b)) & 0xFFFFFFFF;
    }
}
