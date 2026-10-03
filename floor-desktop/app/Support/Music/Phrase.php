<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * A groove's lanes, written as 16-character bar strings and assembled into
 * four-bar phrases.
 *
 * `X` is an accent, `x` a normal hit, `.` a rest. Compact enough to read a whole
 * four-bar pattern at a glance in the library file, which is the point.
 */
final class Phrase
{
    /** 16 steps to a bar. */
    public const STEPS_PER_BAR = 16;

    /** A groove is four bars. */
    public const GROOVE_STEPS = 64;

    /** A full arrangement is sixteen bars. */
    public const SONG_STEPS = 256;

    /**
     * Build a full drum lane from bar strings, mapping characters to velocities.
     *
     * @param  list<string>  $bars
     */
    public static function drums(array $bars, float $hit, float $accent): array
    {
        $lane = [];

        foreach ($bars as $bar) {
            if (strlen($bar) !== self::STEPS_PER_BAR) {
                throw new \InvalidArgumentException(
                    "drum bar must be 16 characters, got ".strlen($bar).": {$bar}"
                );
            }
            foreach (str_split($bar) as $char) {
                $lane[] = match ($char) {
                    'X' => $accent,
                    'x' => $hit,
                    default => 0.0,
                };
            }
        }

        self::assertLength($lane, 'drum lane', self::GROOVE_STEPS);

        return $lane;
    }

    /**
     * Place pitched notes onto a lane, each as `[bar, step, pitch, length, velocity, accent?]`.
     *
     * The lane is sized to span every bar that is written to, so a two-bar bass
     * line yields 32 steps and a four-bar one yields 64.
     *
     * @param  array<int, array{0:int, 1:int, 2:string|array<string>, 3:int, 4:float, 5?:bool}>  $items
     * @return array<int, NoteEvent|null>
     */
    public static function paint(array $items): array
    {
        $span = 4;
        foreach ($items as $item) {
            $span = max($span, $item[0] + 1);
        }

        $lane = array_fill(0, $span * self::STEPS_PER_BAR, null);

        foreach ($items as $item) {
            [$bar, $step, $pitch, $length, $velocity] = $item;
            // PHP does not allow a default inside a list destructuring, so the
            // optional accent is read by key.
            $accent = $item[5] ?? false;
            $index = $bar * self::STEPS_PER_BAR + $step;
            if ($index < 0 || $index >= count($lane)) {
                throw new \InvalidArgumentException("note at step {$index} is outside the lane");
            }
            $names = is_array($pitch) ? $pitch : [$pitch];
            $lane[$index] = new NoteEvent(
                Pitch::midiAll($names),
                (float) $length,
                (float) $velocity,
                (bool) $accent,
            );
        }

        return $lane;
    }

    /**
     * A pumping bass pattern: one note every 4 steps, per bar, from a list of bars.
     *
     * @param  list<list<string>>  $bars
     * @return array<int, NoteEvent|null>
     */
    public static function pumpingBass(array $bars, float $velocity = 0.92, int $length = 2): array
    {
        $lane = array_fill(0, count($bars) * self::STEPS_PER_BAR, null);

        foreach ($bars as $barIndex => $notes) {
            foreach (array_values($notes) as $i => $name) {
                $lane[$barIndex * self::STEPS_PER_BAR + 2 + $i * 4] = new NoteEvent(
                    [Pitch::midi($name)],
                    (float) $length,
                    $velocity,
                    false,
                );
            }
        }

        return $lane;
    }

    /**
     * Cycle through a chord's notes every `every` steps, accenting the downbeat.
     *
     * @param  list<list<string>>  $chords  one chord per bar
     * @return array<int, NoteEvent|null>
     */
    public static function arpCycle(array $chords, int $every, float $velocity): array
    {
        if ($every < 1) {
            throw new \InvalidArgumentException('arp interval must be at least one step');
        }

        $lane = array_fill(0, count($chords) * self::STEPS_PER_BAR, null);

        foreach ($chords as $barIndex => $chord) {
            if ($chord === []) {
                continue;
            }
            $k = 0;
            for ($step = 0; $step < self::STEPS_PER_BAR; $step += $every) {
                $onBeat = $step % 4 === 0;
                $lane[$barIndex * self::STEPS_PER_BAR + $step] = new NoteEvent(
                    [Pitch::midi($chord[$k % count($chord)])],
                    1.0,
                    $onBeat ? min(1.0, $velocity + 0.18) : $velocity,
                    $onBeat,
                );
                $k++;
            }
        }

        return $lane;
    }

    /**
     * Expand a bar string into an optional-hit lane, dropping the given bars.
     *
     * @param  list<string>  $lane
     * @param  list<int>  $keep  bar indices to keep
     */
    public static function muteHits(array $lane, array $keep): array
    {
        $allowed = array_flip($keep);

        return array_map(
            static fn (float $velocity, int $index): float => isset($allowed[intdiv($index, self::STEPS_PER_BAR)]) ? $velocity : 0.0,
            $lane,
            array_keys($lane),
        );
    }

    /**
     * Drop every bar of a note lane except the given indices.
     *
     * @param  array<int, NoteEvent|null>  $lane
     * @param  list<int>  $keep
     * @return array<int, NoteEvent|null>
     */
    public static function muteNotes(array $lane, array $keep): array
    {
        $allowed = array_flip($keep);

        foreach ($lane as $index => $event) {
            if (! isset($allowed[intdiv($index, self::STEPS_PER_BAR)])) {
                $lane[$index] = null;
            }
        }

        return $lane;
    }

    /**
     * Deep-copy a note lane, so sections of an arrangement do not alias each other.
     *
     * @param  array<int, NoteEvent|null>  $lane
     * @return array<int, NoteEvent|null>
     */
    public static function copyNotes(array $lane): array
    {
        return array_map(static fn (?NoteEvent $e): ?NoteEvent => $e?->copy(), $lane);
    }

    /**
     * A lane of silent steps, one groove long by default.
     *
     * @return array<int, float>
     */
    public static function silence(int $steps = self::GROOVE_STEPS): array
    {
        return array_fill(0, $steps, 0.0);
    }

    /**
     * A lane of empty note slots, one groove long by default.
     *
     * @return array<int, null>
     */
    public static function emptyNotes(int $steps = self::GROOVE_STEPS): array
    {
        return array_fill(0, $steps, null);
    }

    /**
     * Concatenate sections into one song-length lane.
     *
     * @param  array<int, mixed>  ...$parts
     * @return array<int, mixed>
     */
    public static function join(array ...$parts): array
    {
        $out = array_merge(...$parts);
        self::assertLength($out, 'joined lane');

        return $out;
    }

    /**
     * Guard the lane length, so a mistyped bar pattern fails at build time rather
     * than as a silent off-by-one in playback.
     *
     * @param  array<int, mixed>  $lane
     */
    private static function assertLength(array $lane, string $what, int $expected = self::SONG_STEPS): void
    {
        $length = count($lane);
        if ($length !== $expected) {
            throw new \InvalidArgumentException(
                "{$what} must be {$expected} steps, got {$length}"
            );
        }
    }
}