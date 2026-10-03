<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * The built-in track library: twelve grooves, six four-on-the-floor and six lo-fi.
 *
 * Each track is four bars long; `Arranger` stretches it into the 16-bar form the
 * engine plays. Definitions live here rather than in the browser bundle so the
 * library can be extended without rebuilding the frontend.
 */
final class Library
{
    public const STEMS = ['kick', 'clap', 'hats', 'bass', 'stab', 'lead', 'pad', 'arp'];

    public const DRUMS = ['kick', 'clap', 'hats'];

    public const MUSIC = ['bass', 'stab', 'lead', 'pad', 'arp'];

    public const PARTS = ['Intro', 'Groove', 'Break', 'Drop'];

    /** @var array<string, Track>|null */
    private static ?array $cache = null;

    /**
     * Every track, in display order.
     *
     * @return array<int, Track>
     */
    public static function all(): array
    {
        return self::$cache ??= self::build();
    }

    /**
     * @return array<int, Track>
     */
    public static function byKind(string $kind): array
    {
        return array_values(array_filter(
            self::all(),
            static fn (Track $t): bool => $t->kind === $kind,
        ));
    }

    public static function find(string $id): ?Track
    {
        return self::all()[$id] ?? null;
    }

    public static function findOrFail(string $id): Track
    {
        return self::find($id) ?? throw new \InvalidArgumentException("unknown track: {$id}");
    }

    /**
     * The next track after `$id`, wrapping at the end — what the cue and the
     * post-mix follow both use.
     */
    public static function next(string $id): Track
    {
        $tracks = array_values(self::all());
        $index = 0;
        foreach ($tracks as $i => $track) {
            if ($track->id === $id) {
                $index = $i;

                break;
            }
        }

        return $tracks[($index + 1) % count($tracks)];
    }

    // -----------------------------------------------------------------------
    // Definitions
    // -----------------------------------------------------------------------

    /** @var array<string, float> */
    private const BASE_MIX = [
        'kick' => 0.9,
        'clap' => 0.5,
        'hats' => 0.36,
        'bass' => 0.8,
        'stab' => 0.38,
        'lead' => 0.36,
        'pad' => 0.3,
        'arp' => 0.32,
    ];

    /** @var array<string, float> */
    private const LOFI_MIX = [
        'kick' => 0.72,
        'clap' => 0.44,
        'hats' => 0.3,
        'bass' => 0.68,
        'stab' => 0.46,
        'lead' => 0.4,
        'pad' => 0.52,
        'arp' => 0.28,
    ];

    /** @return array<string, Track> */
    private static function build(): array
    {
        // Reusable drum and melodic fragments, so a track reads as a set of
        // choices rather than 16 lines of literals.
        $four = 'x...x...x...x...';
        $clap = '....X.......X...';
        $clapFill = '....X.....x.X.x.';
        $hat8 = 'X.x.X.x.X.x.X.x.';
        $open = '..........x.....';

        $boom = 'x.......x..x....';
        $boomB = 'x..x......x.....';
        $boomC = 'x.........x.....';
        $hatLo = 'x.x.x.x.x.x.x.x.';
        $hatLazy = '....x.......x...';
        $openLo = '..............x.';

        $am = ['A4', 'C5', 'E5'];
        $fMaj = ['F4', 'A4', 'C5'];
        $eMin = ['E4', 'G4', 'B4'];
        $am7 = ['A3', 'C4', 'E4', 'G4'];
        $fMaj7 = ['F3', 'A3', 'C4', 'E4'];
        $eMin7 = ['E3', 'G3', 'B3', 'D4'];

        $dm7 = ['D3', 'F3', 'A3', 'C4'];
        $bbMaj7 = ['Bb2', 'D3', 'F3', 'A3'];
        $cMaj7 = ['C3', 'E3', 'G3', 'B3'];
        $dm = ['D4', 'F4', 'A4'];
        $bb = ['Bb3', 'D4', 'F4'];
        $fCh = ['F4', 'A4', 'C5'];
        $cCh = ['C4', 'E4', 'G4'];

        $fm = ['F4', 'Ab4', 'C5'];
        $ab = ['Ab4', 'C5', 'Eb5'];
        $eb = ['Eb4', 'G4', 'Bb4'];
        $bbMaj = ['Bb4', 'D5', 'F5'];
        $fm7 = ['F3', 'Ab3', 'C4', 'Eb4'];
        $abMaj7 = ['Ab3', 'C4', 'Eb4', 'G4'];
        $ebMaj7 = ['Eb3', 'G3', 'Bb3', 'D4'];

        $em = ['E4', 'G4', 'B4'];
        $gMaj = ['G4', 'B4', 'D5'];
        $dMaj = ['D4', 'F#4', 'A4'];
        $em7 = ['E3', 'G3', 'B3', 'D4'];
        $gMaj7 = ['G3', 'B3', 'D4', 'F#4'];
        $dMaj7 = ['D3', 'F#3', 'A3', 'C#4'];

        $gm = ['G4', 'Bb4', 'D5'];
        $gm7 = ['G3', 'Bb3', 'D4', 'F4'];
        $bbHigh = ['Bb3', 'D4', 'F4', 'A4'];

        $e7 = ['E3', 'G#3', 'B3', 'D4'];
        $g7 = ['G3', 'B3', 'D4', 'F4'];
        $gm7Lo = ['G3', 'Bb3', 'D4', 'F4'];

        $tracks = [];

        // -------------------------------------------------------------------
        // Four on the floor
        // -------------------------------------------------------------------

        $tracks[] = new Track(
            id: 'warehouse',
            name: 'Warehouse',
            detail: '126 house',
            kind: 'house',
            bpm: 126.0,
            swing: 0.22,
            mix: self::BASE_MIX,
            kick: Phrase::drums([$four, $four, $four, 'x...x...x...x.x.'], 1.0, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, $clapFill], 0.62, 0.95),
            hat: Phrase::drums([$hat8, $hat8, $hat8, $hat8], 0.4, 0.72),
            hatOpen: Phrase::drums([$open, $open, $open, $open], 0.55, 0.55),
            bass: Phrase::pumpingBass([
                ['A2', 'A2', 'C3', 'A2'],
                ['A2', 'G2', 'A2', 'E2'],
                ['C3', 'A2', 'E3', 'C3'],
                ['G2', 'A2', 'E2', 'G2'],
            ]),
            stab: Phrase::paint([
                [0, 7, $am, 1, 0.55],
                [0, 15, $am, 1, 0.48],
                [1, 7, $am, 1, 0.55],
                [1, 15, $fMaj, 1, 0.5],
                [2, 7, $fMaj, 1, 0.55],
                [2, 15, $eMin, 1, 0.5],
                [3, 7, $eMin, 1, 0.5],
                [3, 15, $am, 1, 0.58],
            ]),
            lead: Phrase::paint([
                [0, 4, 'C5', 6, 0.52],
                [0, 12, 'E4', 3, 0.46],
                [1, 2, 'A4', 8, 0.5],
                [2, 4, 'A4', 4, 0.48],
                [2, 10, 'C5', 4, 0.52],
                [3, 0, 'B4', 4, 0.46],
                [3, 8, 'A4', 6, 0.52],
            ]),
            pad: Phrase::paint([
                [0, 0, $am7, 32, 0.55],
                [2, 0, $fMaj7, 16, 0.5],
                [3, 0, $eMin7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['A4', 'C5', 'E5', 'C5'],
                ['A4', 'C5', 'E5', 'G4'],
                ['F4', 'A4', 'C5', 'A4'],
                ['E4', 'G4', 'B4', 'G4'],
            ], 1, 0.42),
        );

        $tracks[] = new Track(
            id: 'drive',
            name: 'Night Drive',
            detail: '116 deep',
            kind: 'deep',
            bpm: 116.0,
            swing: 0.12,
            mix: ['clap' => 0.4, 'hats' => 0.22, 'bass' => 0.86, 'stab' => 0.32,
                'lead' => 0.42, 'pad' => 0.46, 'arp' => 0.26] + self::BASE_MIX,
            kick: Phrase::drums([$four, $four, $four, $four], 1.0, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, $clap], 0.5, 0.78),
            hat: Phrase::drums([
                'X...x...X...x...', 'X...x...X...x...',
                'X...x...X...x...', 'X...x...X...x...',
            ], 0.4, 0.66),
            hatOpen: Phrase::drums([
                '..............x.', '..............x.',
                '..............x.', '..............x.',
            ], 0.42, 0.42),
            bass: Phrase::paint([
                [0, 0, 'D2', 6, 0.9],
                [0, 8, 'F2', 4, 0.82],
                [0, 12, 'A2', 3, 0.78],
                [1, 0, 'Bb2', 6, 0.88],
                [1, 8, 'D2', 4, 0.8],
                [1, 12, 'F2', 3, 0.76],
                [2, 0, 'F2', 7, 0.9],
                [2, 8, 'C2', 6, 0.84],
                [3, 0, 'C2', 4, 0.86],
                [3, 8, 'G2', 4, 0.8],
                [3, 12, 'A2', 3, 0.9],
            ]),
            stab: Phrase::paint([
                [0, 4, $dm, 2, 0.4], [0, 12, $dm, 2, 0.36],
                [1, 4, $bb, 2, 0.4], [1, 12, $bb, 2, 0.36],
                [2, 4, $fCh, 2, 0.4], [2, 12, $fCh, 2, 0.36],
                [3, 4, $cCh, 2, 0.42], [3, 12, $cCh, 2, 0.36],
            ]),
            lead: Phrase::paint([
                [0, 8, 'A4', 8, 0.46],
                [1, 4, 'F4', 6, 0.42],
                [2, 4, 'C5', 8, 0.48],
                [3, 6, 'D4', 8, 0.46],
            ]),
            pad: Phrase::paint([
                [0, 0, $dm7, 16, 0.6],
                [1, 0, $bbMaj7, 16, 0.55],
                [2, 0, $fMaj7, 16, 0.55],
                [3, 0, $cMaj7, 16, 0.58],
            ]),
            arp: Phrase::arpCycle([
                ['D4', 'F4', 'A4', 'C5'],
                ['Bb3', 'D4', 'F4', 'A4'],
                ['F4', 'A4', 'C5', 'E5'],
                ['C4', 'E4', 'G4', 'B4'],
            ], 2, 0.4),
        );

        $tracks[] = new Track(
            id: 'acid',
            name: 'Acid Line',
            detail: '134 303',
            kind: 'acid',
            bpm: 134.0,
            swing: 0.0,
            mix: ['kick' => 0.88, 'clap' => 0.42, 'hats' => 0.4, 'bass' => 0.9,
                'stab' => 0.24, 'lead' => 0.2, 'pad' => 0.16, 'arp' => 0.22],
            kick: Phrase::drums([$four, $four, $four, $four], 1.0, 1.0),
            clap: Phrase::drums([
                '....X...........', '....X.......X...',
                '....X...........', '....X.......X...',
            ], 0.5, 0.88),
            hat: Phrase::drums([
                'XxxxXxxxXxxxXxxx', 'XxxxXxxxXxxxXxxx',
                'XxxxXxxxXxxxXxxx', 'XxxxXxxxXxxxXxxx',
            ], 0.26, 0.5),
            hatOpen: Phrase::drums([
                '..x...x...x...x.', '..x...x...x...x.',
                '..x...x...x...x.', '..x...x...x...x.',
            ], 0.36, 0.36),
            // The 303 pattern: sixteenths with accents on the ones and the
            // off-beat walk-ups, which is what the engine's acid voicing keys off.
            bass: Phrase::paint(self::acidBass()),
            stab: Phrase::paint([
                [0, 6, $am, 1, 0.4, true],
                [0, 14, ['E4', 'A4', 'C5'], 1, 0.32],
                [1, 6, $am, 1, 0.4, true],
                [1, 14, ['E4', 'A4', 'C5'], 1, 0.32],
                [2, 6, $am, 1, 0.45, true],
                [2, 14, ['G4', 'B4', 'D5'], 1, 0.34],
                [3, 6, ['G4', 'C5', 'E5'], 1, 0.42, true],
                [3, 14, $am, 1, 0.36],
            ]),
            lead: Phrase::paint([
                [0, 4, 'E4', 4, 0.36],
                [1, 8, 'C5', 4, 0.32],
                [2, 4, 'B4', 6, 0.36],
                [3, 8, 'A4', 6, 0.38],
            ]),
            pad: Phrase::paint([[0, 0, ['A2', 'E3'], 64, 0.45]]),
            arp: Phrase::paint(self::acidArp()),
        );

        $tracks[] = new Track(
            id: 'basement',
            name: 'Basement',
            detail: '122 jack',
            kind: 'house',
            bpm: 122.0,
            swing: 0.3,
            mix: ['clap' => 0.58, 'hats' => 0.42, 'bass' => 0.84, 'stab' => 0.46,
                'lead' => 0.4, 'arp' => 0.28] + self::BASE_MIX,
            kick: Phrase::drums([$four, $four, 'x...x...x.x.x...', $four], 1.0, 1.0),
            clap: Phrase::drums([$clap, $clap, '....X...........', $clapFill], 0.55, 0.92),
            hat: Phrase::drums([
                'X.xxX.x.X.xxX.x.', 'X.xxX.x.X.xxX.x.',
                'X.xxX.x.X.xxX.x.', 'X.xxX.x.X.xxX.x.',
            ], 0.38, 0.7),
            hatOpen: Phrase::drums([$open, $open, $open, '......x...x.....'], 0.5, 0.5),
            bass: Phrase::pumpingBass([
                ['F2', 'F2', 'Ab2', 'F2'],
                ['Ab2', 'C3', 'Ab2', 'Eb2'],
                ['Eb2', 'G2', 'Bb2', 'G2'],
                ['C2', 'Bb2', 'Ab2', 'F2'],
            ]),
            stab: Phrase::paint([
                [0, 7, $fm, 1, 0.58], [0, 15, $fm, 1, 0.48],
                [1, 7, $ab, 1, 0.56], [1, 15, $ab, 1, 0.46],
                [2, 7, $eb, 1, 0.56], [2, 15, $bbMaj, 1, 0.5],
                [3, 7, $bbMaj, 1, 0.52], [3, 15, $fm, 1, 0.6],
            ]),
            lead: Phrase::paint([
                [0, 4, 'C5', 6, 0.48],
                [1, 4, 'Eb5', 6, 0.5],
                [2, 2, 'Bb4', 8, 0.46],
                [3, 4, 'Ab4', 8, 0.5],
            ]),
            pad: Phrase::paint([
                [0, 0, $fm7, 16, 0.52],
                [1, 0, $abMaj7, 16, 0.48],
                [2, 0, $ebMaj7, 16, 0.5],
                [3, 0, ['Bb2', 'D3', 'F3', 'Ab3'], 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['F4', 'Ab4', 'C5', 'Eb5'],
                ['Ab4', 'C5', 'Eb5', 'G5'],
                ['Eb4', 'G4', 'Bb4', 'D5'],
                ['Bb4', 'D5', 'F5', 'Ab5'],
            ], 2, 0.4),
        );

        $tracks[] = new Track(
            id: 'glass',
            name: 'Glass',
            detail: '110 glow',
            kind: 'deep',
            bpm: 110.0,
            swing: 0.08,
            mix: ['kick' => 0.86, 'clap' => 0.36, 'hats' => 0.18, 'bass' => 0.82,
                'stab' => 0.3, 'lead' => 0.48, 'pad' => 0.5, 'arp' => 0.24],
            kick: Phrase::drums([$four, $four, $four, $four], 1.0, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, $clap], 0.42, 0.7),
            hat: Phrase::drums([
                'X.......x.......', 'X.......x.......',
                'X.......x.......', 'X...x...x...x...',
            ], 0.36, 0.6),
            hatOpen: Phrase::drums([
                '..............x.', '..............x.',
                '..............x.', '..........x.....',
            ], 0.4, 0.4),
            bass: Phrase::paint([
                [0, 0, 'E2', 8, 0.9], [0, 8, 'B2', 6, 0.8],
                [1, 0, 'C2', 8, 0.88], [1, 8, 'G2', 6, 0.78],
                [2, 0, 'G2', 6, 0.88], [2, 8, 'D2', 6, 0.8],
                [3, 0, 'B2', 4, 0.86], [3, 8, 'E2', 6, 0.9],
            ]),
            stab: Phrase::paint([
                [0, 4, $em, 2, 0.38], [0, 12, $em, 2, 0.32],
                [1, 4, $cCh, 2, 0.38], [1, 12, $cCh, 2, 0.32],
                [2, 4, $gMaj, 2, 0.4], [2, 12, $gMaj, 2, 0.34],
                [3, 4, $dMaj, 2, 0.4], [3, 12, $em, 2, 0.36],
            ]),
            lead: Phrase::paint([
                [0, 6, 'B4', 8, 0.46],
                [1, 4, 'G4', 8, 0.44],
                [2, 4, 'D5', 6, 0.48],
                [3, 6, 'E4', 8, 0.46],
            ]),
            pad: Phrase::paint([
                [0, 0, $em7, 16, 0.58],
                [1, 0, $cMaj7, 16, 0.52],
                [2, 0, $gMaj7, 16, 0.55],
                [3, 0, $dMaj7, 16, 0.56],
            ]),
            arp: Phrase::arpCycle([
                ['E4', 'G4', 'B4', 'D5'],
                ['C4', 'E4', 'G4', 'B4'],
                ['G4', 'B4', 'D5', 'F#5'],
                ['D4', 'F#4', 'A4', 'C#5'],
            ], 2, 0.36),
        );

        $tracks[] = new Track(
            id: 'tunnel',
            name: 'Tunnel',
            detail: '128 peak',
            kind: 'house',
            bpm: 128.0,
            swing: 0.14,
            mix: ['hats' => 0.4, 'bass' => 0.86, 'stab' => 0.42, 'lead' => 0.46,
                'pad' => 0.26, 'arp' => 0.3] + self::BASE_MIX,
            kick: Phrase::drums([$four, $four, $four, 'x...x...x...xx..'], 1.0, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, $clapFill], 0.58, 0.94),
            hat: Phrase::drums([
                'X.xxX.xxX.xxX.xx', 'X.xxX.xxX.xxX.xx',
                'X.xxX.xxX.xxX.xx', 'X.xxX.xxX.xxX.xx',
            ], 0.36, 0.68),
            hatOpen: Phrase::drums([
                '......x.......x.', '......x.......x.',
                '......x.......x.', '......x...x...x.',
            ], 0.52, 0.52),
            bass: Phrase::pumpingBass([
                ['G2', 'G2', 'Bb2', 'G2'],
                ['Eb2', 'Eb2', 'G2', 'Bb2'],
                ['Bb2', 'Bb2', 'D3', 'Bb2'],
                ['F2', 'A2', 'G2', 'D2'],
            ]),
            stab: Phrase::paint([
                [0, 6, $gm, 1, 0.56], [0, 14, $gm, 1, 0.46],
                [1, 6, $eb, 1, 0.54], [1, 14, $eb, 1, 0.46],
                [2, 6, $bbMaj, 1, 0.54], [2, 14, $bbMaj, 1, 0.48],
                [3, 6, $fCh, 1, 0.52], [3, 14, $gm, 1, 0.58],
            ]),
            lead: Phrase::paint([
                [0, 4, 'Bb4', 6, 0.48],
                [1, 2, 'G4', 8, 0.46],
                [2, 4, 'D5', 6, 0.5],
                [3, 4, 'C5', 8, 0.48],
            ]),
            pad: Phrase::paint([
                [0, 0, $gm7, 16, 0.5],
                [1, 0, $ebMaj7, 16, 0.46],
                [2, 0, $bbHigh, 16, 0.48],
                [3, 0, $fMaj7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['G4', 'Bb4', 'D5', 'F5'],
                ['Eb4', 'G4', 'Bb4', 'D5'],
                ['Bb4', 'D5', 'F5', 'A5'],
                ['F4', 'A4', 'C5', 'D5'],
            ], 2, 0.4),
        );

        // -------------------------------------------------------------------
        // Lo-fi
        // -------------------------------------------------------------------

        $tracks[] = self::lofiTrack(
            id: 'rain', name: 'Rain', detail: '84 dust', bpm: 84.0, swing: 0.52,
            mix: self::LOFI_MIX,
            kick: Phrase::drums([$boom, $boom, $boom, 'x.......x.x.x...'], 0.9, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, '....X....x..X...'], 0.45, 0.8),
            hat: Phrase::drums([$hatLo, $hatLo, $hatLo, $hatLo], 0.32, 0.5),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, $openLo], 0.28, 0.28),
            bass: Phrase::paint([
                [0, 0, 'A2', 8, 0.8], [0, 8, 'C3', 6, 0.7],
                [1, 0, 'D2', 8, 0.78], [1, 10, 'E2', 4, 0.68],
                [2, 0, 'F2', 8, 0.8], [2, 8, 'E2', 6, 0.7],
                [3, 0, 'E2', 4, 0.76], [3, 8, 'A2', 6, 0.82],
            ]),
            stab: Phrase::paint([
                [0, 4, $am, 3, 0.42], [0, 12, $am, 2, 0.32],
                [1, 4, ['D4', 'F4', 'A4'], 3, 0.4], [1, 12, ['D4', 'F4', 'A4'], 2, 0.3],
                [2, 4, $fMaj, 3, 0.42], [2, 12, $fMaj, 2, 0.32],
                [3, 4, ['E4', 'G#4', 'B4'], 3, 0.4], [3, 12, $am, 2, 0.36],
            ]),
            lead: Phrase::paint([
                [0, 8, 'C5', 6, 0.4],
                [1, 4, 'A4', 8, 0.38],
                [2, 4, 'F4', 6, 0.4],
                [3, 8, 'E4', 6, 0.42],
            ]),
            pad: Phrase::paint([
                [0, 0, $am7, 16, 0.55],
                [1, 0, $dm7, 16, 0.5],
                [2, 0, $fMaj7, 16, 0.52],
                [3, 0, $e7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['A4', 'C5', 'E5', 'G4'],
                ['D4', 'F4', 'A4', 'C5'],
                ['F4', 'A4', 'C5', 'E5'],
                ['E4', 'G#4', 'B4', 'D5'],
            ], 4, 0.32),
        );

        $tracks[] = self::lofiTrack(
            id: 'study', name: 'Study', detail: '76 page', bpm: 76.0, swing: 0.58,
            mix: ['hats' => 0.14, 'pad' => 0.58, 'lead' => 0.3] + self::LOFI_MIX,
            kick: Phrase::drums([$boomC, $boomC, $boomC, 'x.........x..x..'], 0.86, 1.0),
            clap: Phrase::drums([$clap, $clap, '....X...........', $clap], 0.4, 0.72),
            hat: Phrase::drums([$hatLazy, $hatLazy, $hatLo, $hatLazy], 0.28, 0.42),
            hatOpen: Phrase::drums([
                '................', '..............x.',
                '................', '..............x.',
            ], 0.22, 0.22),
            bass: Phrase::paint([
                [0, 0, 'D2', 10, 0.78],
                [1, 0, 'G2', 8, 0.74], [1, 10, 'A2', 4, 0.66],
                [2, 0, 'C2', 10, 0.76],
                [3, 0, 'A2', 6, 0.74], [3, 8, 'D2', 6, 0.8],
            ]),
            stab: Phrase::paint([
                [0, 6, $dm, 4, 0.36],
                [1, 6, ['G4', 'Bb4', 'D5'], 4, 0.34],
                [2, 6, $cCh, 4, 0.36],
                [3, 6, ['A4', 'C5', 'E5'], 3, 0.32],
            ]),
            lead: Phrase::paint([
                [0, 4, 'A4', 8, 0.36],
                [1, 8, 'F4', 6, 0.34],
                [2, 4, 'E4', 8, 0.36],
                [3, 8, 'D4', 6, 0.38],
            ]),
            pad: Phrase::paint([
                [0, 0, $dm7, 16, 0.58],
                [1, 0, $gm7Lo, 16, 0.52],
                [2, 0, $cMaj7, 16, 0.54],
                [3, 0, $am7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['D4', 'F4', 'A4', 'C5'],
                ['G3', 'Bb3', 'D4', 'F4'],
                ['C4', 'E4', 'G4', 'B4'],
                ['A3', 'C4', 'E4', 'G4'],
            ], 4, 0.28),
        );

        $tracks[] = self::lofiTrack(
            id: 'porch', name: 'Porch', detail: '92 sun', bpm: 92.0, swing: 0.36,
            mix: ['hats' => 0.24, 'stab' => 0.48] + self::LOFI_MIX,
            kick: Phrase::drums([$boomB, $boomB, $boom, $boomB], 0.88, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, $clapFill], 0.42, 0.78),
            hat: Phrase::drums([$hatLo, $hatLo, $hatLo, $hatLo], 0.34, 0.52),
            hatOpen: Phrase::drums([$open, $open, $open, '......x.......x.'], 0.3, 0.3),
            bass: Phrase::paint([
                [0, 0, 'F2', 6, 0.8], [0, 8, 'A2', 6, 0.7],
                [1, 0, 'Bb2', 8, 0.78], [1, 10, 'D3', 4, 0.68],
                [2, 0, 'C2', 6, 0.76], [2, 8, 'E2', 6, 0.7],
                [3, 0, 'F2', 4, 0.8], [3, 8, 'C2', 6, 0.74],
            ]),
            stab: Phrase::paint([
                [0, 4, $fCh, 3, 0.46], [0, 12, $fCh, 2, 0.34],
                [1, 4, $bb, 3, 0.44], [1, 12, $bb, 2, 0.32],
                [2, 4, $cCh, 3, 0.44], [2, 12, $cCh, 2, 0.32],
                [3, 4, $fCh, 3, 0.48], [3, 12, $am, 2, 0.34],
            ]),
            lead: Phrase::paint([
                [0, 4, 'A4', 6, 0.4],
                [1, 2, 'F4', 8, 0.42],
                [2, 6, 'E4', 6, 0.4],
                [3, 4, 'C5', 8, 0.44],
            ]),
            pad: Phrase::paint([
                [0, 0, $fMaj7, 16, 0.54],
                [1, 0, $bbHigh, 16, 0.5],
                [2, 0, $cMaj7, 16, 0.52],
                [3, 0, $am7, 16, 0.48],
            ]),
            arp: Phrase::arpCycle([
                ['F4', 'A4', 'C5', 'E5'],
                ['Bb3', 'D4', 'F4', 'A4'],
                ['C4', 'E4', 'G4', 'B4'],
                ['A3', 'C4', 'E4', 'G4'],
            ], 4, 0.3),
        );

        $tracks[] = self::lofiTrack(
            id: 'tape', name: 'Tape', detail: '80 hiss', bpm: 80.0, swing: 0.5,
            mix: ['pad' => 0.6, 'arp' => 0.22] + self::LOFI_MIX,
            kick: Phrase::drums([$boom, $boomC, $boom, 'x..x....x..x....'], 0.84, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, '....X....x..X.x.'], 0.4, 0.74),
            hat: Phrase::drums([$hatLo, $hatLazy, $hatLo, $hatLo], 0.3, 0.46),
            hatOpen: Phrase::drums([$openLo, '................', $openLo, $openLo], 0.24, 0.24),
            bass: Phrase::paint([
                [0, 0, 'C2', 8, 0.78], [0, 10, 'E2', 4, 0.66],
                [1, 0, 'A2', 8, 0.76], [1, 10, 'G2', 4, 0.68],
                [2, 0, 'D2', 10, 0.78],
                [3, 0, 'G2', 6, 0.74], [3, 8, 'C2', 6, 0.8],
            ]),
            stab: Phrase::paint([
                [0, 4, $cCh, 4, 0.38],
                [1, 4, $am, 4, 0.36],
                [2, 4, $dm, 4, 0.38],
                [3, 4, ['G4', 'B4', 'D5'], 3, 0.34],
                [3, 12, $cCh, 2, 0.3],
            ]),
            lead: Phrase::paint([
                [0, 6, 'G4', 8, 0.38],
                [1, 4, 'E4', 8, 0.4],
                [2, 4, 'A4', 8, 0.4],
                [3, 8, 'B4', 6, 0.38],
            ]),
            pad: Phrase::paint([
                [0, 0, $cMaj7, 16, 0.56],
                [1, 0, $am7, 16, 0.52],
                [2, 0, $dm7, 16, 0.54],
                [3, 0, $g7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['C4', 'E4', 'G4', 'B4'],
                ['A3', 'C4', 'E4', 'G4'],
                ['D4', 'F4', 'A4', 'C5'],
                ['G3', 'B3', 'D4', 'F4'],
            ], 4, 0.28),
        );

        $tracks[] = self::lofiTrack(
            id: 'nightbus', name: 'Nightbus', detail: '88 ride', bpm: 88.0, swing: 0.44,
            mix: ['bass' => 0.74, 'lead' => 0.4] + self::LOFI_MIX,
            kick: Phrase::drums([$boomB, $boom, $boomB, $boom], 0.9, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, $clap], 0.42, 0.76),
            hat: Phrase::drums([$hatLo, $hatLo, $hatLo, 'x.x.x.x.x.x.x.X.'], 0.32, 0.5),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, '......x.......x.'], 0.26, 0.26),
            bass: Phrase::paint([
                [0, 0, 'E2', 8, 0.8], [0, 8, 'B2', 6, 0.7],
                [1, 0, 'C2', 8, 0.78], [1, 10, 'G2', 4, 0.68],
                [2, 0, 'G2', 6, 0.78], [2, 8, 'D2', 6, 0.7],
                [3, 0, 'B2', 4, 0.74], [3, 8, 'E2', 6, 0.82],
            ]),
            stab: Phrase::paint([
                [0, 4, $em, 3, 0.4], [0, 12, $em, 2, 0.3],
                [1, 4, $cCh, 3, 0.38], [1, 12, $cCh, 2, 0.3],
                [2, 4, $gMaj, 3, 0.4], [2, 12, $gMaj, 2, 0.3],
                [3, 4, $dMaj, 3, 0.38], [3, 12, $em, 2, 0.34],
            ]),
            lead: Phrase::paint([
                [0, 8, 'B4', 6, 0.4],
                [1, 2, 'G4', 8, 0.42],
                [2, 4, 'D5', 6, 0.4],
                [3, 8, 'E4', 6, 0.42],
            ]),
            pad: Phrase::paint([
                [0, 0, $em7, 16, 0.55],
                [1, 0, $cMaj7, 16, 0.5],
                [2, 0, $gMaj7, 16, 0.52],
                [3, 0, $dMaj7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['E4', 'G4', 'B4', 'D5'],
                ['C4', 'E4', 'G4', 'B4'],
                ['G4', 'B4', 'D5', 'F#5'],
                ['D4', 'F#4', 'A4', 'C#5'],
            ], 4, 0.3),
        );

        $tracks[] = self::lofiTrack(
            id: 'kettle', name: 'Kettle', detail: '74 steam', bpm: 74.0, swing: 0.62,
            mix: ['kick' => 0.66, 'hats' => 0.12, 'pad' => 0.62, 'arp' => 0.14] + self::LOFI_MIX,
            kick: Phrase::drums([$boomC, $boomC, 'x...............', $boomC], 0.82, 1.0),
            clap: Phrase::drums([
                $clap, '....X...........', $clap, '....X.......X...',
            ], 0.36, 0.66),
            hat: Phrase::drums([$hatLazy, $hatLazy, $hatLazy, $hatLo], 0.26, 0.4),
            hatOpen: Phrase::drums([
                '................', $openLo, '................', $openLo,
            ], 0.2, 0.2),
            bass: Phrase::paint([
                [0, 0, 'Bb2', 12, 0.76],
                [1, 0, 'Eb2', 10, 0.74],
                [2, 0, 'G2', 8, 0.72], [2, 10, 'F2', 4, 0.66],
                [3, 0, 'F2', 6, 0.74], [3, 8, 'Bb2', 6, 0.8],
            ]),
            stab: Phrase::paint([
                [0, 8, $bb, 4, 0.34],
                [1, 8, $eb, 4, 0.32],
                [2, 8, ['G4', 'Bb4', 'D5'], 4, 0.34],
                [3, 4, $fCh, 4, 0.32],
            ]),
            lead: Phrase::paint([
                [0, 4, 'D4', 8, 0.34],
                [1, 6, 'Bb4', 8, 0.34],
                [2, 4, 'C5', 8, 0.36],
                [3, 8, 'A4', 6, 0.36],
            ]),
            pad: Phrase::paint([
                [0, 0, $bbHigh, 16, 0.58],
                [1, 0, $ebMaj7, 16, 0.54],
                [2, 0, $gm7Lo, 16, 0.52],
                [3, 0, $fMaj7, 16, 0.5],
            ]),
            arp: Phrase::arpCycle([
                ['Bb3', 'D4', 'F4', 'A4'],
                ['Eb4', 'G4', 'Bb4', 'D5'],
                ['G3', 'Bb3', 'D4', 'F4'],
                ['F3', 'A3', 'C4', 'E4'],
            ], 4, 0.26),
        );

        return array_column(array_map(static fn (Track $t): array => [$t->id, $t], $tracks), 1, 0);
    }

    /**
     * The acid bassline, written out bar by bar: sixteenths with accents driving
     * the resonant sweep, and chromatic walk-ups between chord roots.
     *
     * @return list<array{0:int, 1:int, 2:string, 3:int, 4:float, 5?:bool}>
     */
    private static function acidBass(): array
    {
        $bars = [
            0 => [[0, 'A2', 0.95, true], [1, 'A2', 0.7], [3, 'C3', 0.75], [5, 'A2', 0.72],
                [7, 'E2', 0.7], [9, 'G2', 0.74], [10, 'A2', 0.95, true], [12, 'C3', 0.78],
                [13, 'D3', 0.8], [14, 'C3', 0.92, true], [15, 'A2', 0.7]],
            1 => [[0, 'A2', 0.8], [2, 'C3', 0.95, true], [3, 'C3', 0.72], [4, 'E3', 0.84],
                [6, 'D3', 0.76], [7, 'C3', 0.7], [8, 'A2', 0.95, true], [9, 'G2', 0.7],
                [11, 'A2', 0.78], [13, 'E2', 0.72], [14, 'G2', 0.9, true]],
            2 => [[0, 'A2', 0.95, true], [1, 'A2', 0.7], [3, 'C3', 0.8], [5, 'A2', 0.72],
                [7, 'E2', 0.7], [9, 'G2', 0.78], [10, 'A2', 0.96, true], [12, 'C3', 0.8],
                [13, 'D3', 0.84], [14, 'E3', 0.94, true], [15, 'C3', 0.72]],
            3 => [[0, 'A2', 0.88, true], [2, 'C3', 0.8], [3, 'D3', 0.76], [4, 'E3', 0.9, true],
                [6, 'D3', 0.74], [7, 'C3', 0.7], [8, 'A2', 0.95, true], [10, 'G2', 0.78],
                [11, 'A2', 0.8], [13, 'E2', 0.72], [14, 'A2', 0.92, true]],
        ];

        $out = [];
        foreach ($bars as $bar => $notes) {
            foreach (array_values($notes) as $note) {
                [$step, $pitch, $velocity] = $note;
                $accent = $note[3] ?? false;
                $out[] = [(int) $bar, $step, $pitch, 1, $velocity, $accent];
            }
        }

        return $out;
    }

    /**
     * The acid arp: a six-note figure over the top octave, high and glassy.
     *
     * @return list<array{0:int, 1:int, 2:string, 3:int, 4:float}>
     */
    private static function acidArp(): array
    {
        $pitches = ['A5', 'C6', 'E6', 'G5', 'E6', 'C6'];
        $steps = [0, 3, 6, 10, 12, 15];

        $out = [];
        for ($bar = 0; $bar < 4; $bar++) {
            foreach ($steps as $i => $step) {
                $out[] = [$bar, $step, $pitches[$i] ?? 'A5', 1, $i % 2 === 0 ? 0.42 : 0.3];
            }
        }

        return $out;
    }

    /**
     * Lo-fi tracks share a lot of structure, so they are built from one signature.
     *
     * @param  array<string, float>  $mix
     * @param  array<int, float>  $kick
     * @param  array<int, float>  $clap
     * @param  array<int, float>  $hat
     * @param  array<int, float>  $hatOpen
     * @param  array<int, NoteEvent|null>  $bass
     * @param  array<int, NoteEvent|null>  $stab
     * @param  array<int, NoteEvent|null>  $lead
     * @param  array<int, NoteEvent|null>  $pad
     * @param  array<int, NoteEvent|null>  $arp
     */
    private static function lofiTrack(
        string $id,
        string $name,
        string $detail,
        float $bpm,
        float $swing,
        array $mix,
        array $kick,
        array $clap,
        array $hat,
        array $hatOpen,
        array $bass,
        array $stab,
        array $lead,
        array $pad,
        array $arp,
    ): Track {
        return new Track(
            id: $id,
            name: $name,
            detail: $detail,
            kind: 'lofi',
            bpm: $bpm,
            swing: $swing,
            mix: $mix,
            kick: $kick,
            clap: $clap,
            hat: $hat,
            hatOpen: $hatOpen,
            bass: $bass,
            stab: $stab,
            lead: $lead,
            pad: $pad,
            arp: $arp,
        );
    }
}