<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * Note names to MIDI numbers, e.g. `Bb2` => 46.
 *
 * The engine works in MIDI numbers throughout so the Rust side never parses
 * note names; only this class and the pattern builders deal in strings.
 */
final class Pitch
{
    private const PITCH = [
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
    ];

    /**
     * MIDI number for a note name such as `A4`, `F#3` or `Eb2`.
     *
     * Parsed by hand rather than by pattern so `Bb2` and `F#3` both work; the
     * original implementation only accepted a single accidental digit.
     */
    public static function midi(string $name): int
    {
        $name = trim($name);
        if ($name === '') {
            throw new \InvalidArgumentException('empty note name');
        }

        $letter = strtoupper($name[0]);
        if (! isset(self::PITCH[$letter])) {
            throw new \InvalidArgumentException("bad note name: {$name}");
        }

        $rest = substr($name, 1);
        $accidental = 0;
        if ($rest !== '' && ($rest[0] === '#' || $rest[0] === 'b')) {
            $accidental = $rest[0] === '#' ? 1 : -1;
            $rest = substr($rest, 1);
        }

        if ($rest === '' || preg_match('/^-?\d+$/', $rest) !== 1) {
            throw new \InvalidArgumentException("bad note name: {$name}");
        }

        // C in octave -1 is MIDI 0, hence the +1 on the octave.
        return ((int) $rest + 1) * 12 + self::PITCH[$letter] + $accidental;
    }

    /** MIDI numbers for a chord, e.g. `['A3', 'C4', 'E4']`. */
    public static function midiAll(array $names): array
    {
        return array_map(static fn (string $n): int => self::midi($n), $names);
    }
}