<?php

declare(strict_types=1);

namespace App\Support\Music;

/**
 * The built-in track library: eighteen grooves, six each of EDM, lo-fi and breaks.
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

    /**
     * Every track in display order, with its library section and sub-genre.
     *
     * @var list<array{0:string, 1:string, 2:string}>
     */
    private const GROUPS = [
        ['warehouse', 'EDM', 'House'],
        ['basement', 'EDM', 'House'],
        ['tunnel', 'EDM', 'House'],
        ['drive', 'EDM', 'Deep'],
        ['glass', 'EDM', 'Deep'],
        ['acid', 'EDM', 'Acid'],
        ['rain', 'Lofi', 'Chillhop'],
        ['study', 'Lofi', 'Chillhop'],
        ['porch', 'Lofi', 'Chillhop'],
        ['tape', 'Lofi', 'Dusty'],
        ['nightbus', 'Lofi', 'Dusty'],
        ['kettle', 'Lofi', 'Jazz'],
        ['southside', 'Breaks', 'Garage'],
        ['pirate', 'Breaks', 'Garage'],
        ['bricks', 'Breaks', 'Breakbeat'],
        ['ravetape', 'Breaks', 'Breakbeat'],
        ['lowtide', 'Breaks', 'Liquid DnB'],
        ['slipstream', 'Breaks', 'Liquid DnB'],
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
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, '..x...x...x...x.'), 0.3, 0.36),
                'rim' => Phrase::drums(['................', '................', '................', '...........x....'], 0.4, 0.4),
            ],
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
            perc: [
                'rim' => Phrase::drums(['................', '....x.......x...', '................', '...............x'], 0.36, 0.42),
                'congaLo' => Phrase::drums(array_fill(0, 4, '..........x.....'), 0.32, 0.32),
            ],
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
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, '.x.x.x.x.x.x.x.x'), 0.16, 0.22),
                'congaHi' => Phrase::drums([
                    '..x..x....x..x..', '..x..x....x.....', '..x..x....x..x..', '..x..x....x.x.x.',
                ], 0.36, 0.46),
                'congaLo' => Phrase::drums(array_fill(0, 4, '......x.......x.'), 0.4, 0.46),
            ],
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
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, 'x.x.x.x.x.x.x.x.'), 0.18, 0.26),
                'rim' => Phrase::drums(['................', '...x.......x....', '................', '...x.......x....'], 0.34, 0.34),
            ],
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
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, '..x...x...x...x.'), 0.2, 0.26),
                'rim' => Phrase::drums(array_fill(0, 4, '.......x......x.'), 0.3, 0.3),
            ],
        );

        // Kettle: jazz changes in B-flat, ii-V-I-vi with ninths on every chord, so no
        // voice ever sits a tritone off the bass. The swing is the lightest in the lo-fi
        // set because it is also the slowest — at 78 bpm a heavy shuffle reads as a stumble.
        $cm9 = ['C3', 'Eb3', 'Bb3', 'D4'];
        $f9 = ['F3', 'A3', 'Eb4', 'G4'];
        $bbMaj9 = ['Bb2', 'D3', 'A3', 'C4'];
        $gm9 = ['G2', 'Bb2', 'F3', 'A3'];
        $cm9Hi = ['Eb4', 'G4', 'Bb4', 'D5'];
        $f9Hi = ['A3', 'Eb4', 'G4', 'C5'];
        $bbMaj9Hi = ['D4', 'F4', 'A4', 'C5'];
        $gm9Hi = ['Bb3', 'D4', 'F4', 'A4'];

        $tracks[] = self::lofiTrack(
            id: 'kettle', name: 'Kettle', detail: '78 jazz', bpm: 78.0, swing: 0.45,
            mix: ['pad' => 0.56, 'arp' => 0.2] + self::LOFI_MIX,
            kick: Phrase::drums([$boom, $boomB, $boom, 'x.......x.x.....'], 0.9, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, '....X....x..X...'], 0.42, 0.78),
            hat: Phrase::drums([$hatLo, $hatLo, $hatLo, $hatLo], 0.3, 0.48),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, $openLo], 0.24, 0.24),
            bass: Phrase::paint([
                [0, 0, 'C2', 6, 0.82], [0, 8, 'G2', 4, 0.7], [0, 12, 'Bb2', 2, 0.66],
                [1, 0, 'F2', 6, 0.8], [1, 8, 'C3', 4, 0.7], [1, 12, 'A2', 2, 0.66],
                [2, 0, 'Bb1', 6, 0.82], [2, 8, 'F2', 4, 0.7], [2, 12, 'A2', 2, 0.66],
                [3, 0, 'G2', 6, 0.8], [3, 8, 'F2', 3, 0.7], [3, 12, 'D2', 2, 0.68],
            ]),
            stab: Phrase::paint([
                [0, 4, $cm9Hi, 2, 0.36], [0, 11, $cm9Hi, 1, 0.28],
                [1, 4, $f9Hi, 2, 0.36], [1, 11, $f9Hi, 1, 0.28],
                [2, 4, $bbMaj9Hi, 2, 0.36], [2, 11, $bbMaj9Hi, 1, 0.28],
                [3, 4, $gm9Hi, 2, 0.36], [3, 11, $gm9Hi, 1, 0.3],
            ]),
            lead: Phrase::paint([
                [0, 2, 'G4', 2, 0.4], [0, 4, 'Bb4', 2, 0.38], [0, 6, 'C5', 4, 0.42], [0, 12, 'D5', 2, 0.36],
                [1, 0, 'C5', 3, 0.4], [1, 4, 'A4', 2, 0.36], [1, 8, 'F4', 4, 0.38],
                [2, 2, 'D5', 2, 0.42], [2, 4, 'C5', 2, 0.38], [2, 6, 'A4', 6, 0.4],
                [3, 0, 'Bb4', 2, 0.38], [3, 2, 'A4', 2, 0.36], [3, 4, 'G4', 4, 0.4], [3, 10, 'F4', 4, 0.36],
            ]),
            pad: Phrase::paint([
                [0, 0, $cm9, 16, 0.5],
                [1, 0, $f9, 16, 0.48],
                [2, 0, $bbMaj9, 16, 0.5],
                [3, 0, $gm9, 16, 0.48],
            ]),
            arp: Phrase::arpCycle([$cm9Hi, $f9Hi, $bbMaj9Hi, $gm9Hi], 4, 0.22),
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, 'X.xxX.xxX.xxX.xx'), 0.14, 0.24),
                'rim' => Phrase::drums(['............x...', '............x...', '............x...', '........x...x...'], 0.36, 0.4),
            ],
        );

        // -------------------------------------------------------------------
        // Breaks: garage, breakbeat and liquid drum & bass. Broken kicks and
        // shuffled hats, on the engine's existing house, deep and acid voicings.
        // -------------------------------------------------------------------

        $twoStep = 'x.........x.....';
        $twoStepB = 'x......x..x.....';
        $hatGarage = '..x.xx.x..x.xx.x';
        $snareGhost = '....X..x.x..X..x';
        $dnbKick = 'x.........x.....';
        $hatDnb = 'x.x.x.xxx.x.x.xx';

        $tracks[] = new Track(
            id: 'southside',
            name: 'Southside',
            detail: '132 garage',
            kind: 'deep',
            bpm: 132.0,
            swing: 0.36,
            mix: ['hats' => 0.42, 'stab' => 0.46, 'pad' => 0.28, 'arp' => 0.22] + self::BASE_MIX,
            kick: Phrase::drums([$twoStep, $twoStepB, $twoStep, 'x......x..x...x.'], 0.95, 1.0),
            clap: Phrase::drums([$clap, $clap, $clap, '....X.......X.x.'], 0.5, 0.9),
            hat: Phrase::drums([$hatGarage, $hatGarage, $hatGarage, $hatGarage], 0.34, 0.6),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, $openLo], 0.4, 0.4),
            bass: Phrase::paint([
                [0, 0, 'F2', 3, 0.86], [0, 7, 'F2', 2, 0.74], [0, 10, 'Ab2', 3, 0.8], [0, 14, 'C3', 2, 0.72],
                [1, 0, 'Db2', 3, 0.86], [1, 7, 'Db2', 2, 0.74], [1, 10, 'F2', 3, 0.8], [1, 14, 'Ab2', 2, 0.72],
                [2, 0, 'Eb2', 3, 0.86], [2, 7, 'Eb2', 2, 0.74], [2, 10, 'G2', 3, 0.8], [2, 14, 'Bb2', 2, 0.72],
                [3, 0, 'C2', 3, 0.86], [3, 7, 'C2', 2, 0.74], [3, 10, 'Eb2', 3, 0.8], [3, 13, 'G2', 3, 0.74],
            ]),
            stab: Phrase::paint([
                [0, 3, ['Ab3', 'C4', 'Eb4', 'G4'], 2, 0.5], [0, 10, ['Ab3', 'C4', 'Eb4', 'G4'], 2, 0.44],
                [1, 3, ['Ab3', 'C4', 'Db4', 'F4'], 2, 0.5], [1, 10, ['Ab3', 'C4', 'Db4', 'F4'], 2, 0.44],
                [2, 3, ['G3', 'Bb3', 'Eb4', 'F4'], 2, 0.5], [2, 10, ['G3', 'Bb3', 'Eb4', 'F4'], 2, 0.44],
                [3, 3, ['G3', 'Bb3', 'C4', 'Eb4'], 2, 0.5], [3, 10, ['G3', 'Bb3', 'C4', 'Eb4'], 2, 0.44],
                [3, 14, ['G3', 'Bb3', 'C4', 'Eb4'], 1, 0.4],
            ]),
            lead: Phrase::paint([
                [0, 6, 'C5', 2, 0.44], [0, 8, 'Eb5', 4, 0.46],
                [1, 6, 'Db5', 2, 0.44], [1, 8, 'C5', 4, 0.46],
                [2, 6, 'Bb4', 2, 0.44], [2, 8, 'G4', 4, 0.46],
                [3, 2, 'C5', 2, 0.44], [3, 6, 'Bb4', 2, 0.42], [3, 10, 'G4', 4, 0.46],
            ]),
            pad: Phrase::paint([
                [0, 0, $fm7, 16, 0.4],
                [1, 0, ['Db3', 'F3', 'Ab3', 'C4'], 16, 0.4],
                [2, 0, $ebMaj7, 16, 0.4],
                [3, 0, ['C3', 'Eb3', 'G3', 'Bb3'], 16, 0.4],
            ]),
            arp: Phrase::arpCycle([
                ['F4', 'Ab4', 'C5', 'Eb5'],
                ['Db4', 'F4', 'Ab4', 'C5'],
                ['Eb4', 'G4', 'Bb4', 'D5'],
                ['C4', 'Eb4', 'G4', 'Bb4'],
            ], 3, 0.24),
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, '.x.x.x.x.x.x.x.x'), 0.2, 0.3),
                'rim' => Phrase::drums([
                    '......x.......x.', '...x..x.......x.', '......x.......x.', '...x..x....x..x.',
                ], 0.4, 0.55),
            ],
        );

        $tracks[] = new Track(
            id: 'pirate',
            name: 'Pirate',
            detail: '134 garage',
            kind: 'house',
            bpm: 134.0,
            swing: 0.3,
            mix: ['hats' => 0.4, 'stab' => 0.44, 'lead' => 0.3, 'arp' => 0.2] + self::BASE_MIX,
            kick: Phrase::drums([$twoStep, 'x.........x..x..', $twoStep, $twoStepB], 0.95, 1.0),
            clap: Phrase::drums([$clap, '....X..x....X...', $clap, '....X..x....X.x.'], 0.4, 0.9),
            hat: Phrase::drums([$hatGarage, $hatGarage, $hatGarage, $hatGarage], 0.32, 0.58),
            hatOpen: Phrase::drums([$open, $open, $open, $open], 0.42, 0.42),
            bass: Phrase::paint([
                [0, 0, 'G2', 2, 0.86], [0, 3, 'G3', 1, 0.7], [0, 7, 'G2', 2, 0.8], [0, 10, 'Bb2', 2, 0.8], [0, 14, 'D3', 2, 0.74],
                [1, 0, 'Eb2', 2, 0.86], [1, 3, 'Eb3', 1, 0.7], [1, 7, 'Eb2', 2, 0.8], [1, 10, 'G2', 2, 0.8], [1, 14, 'Bb2', 2, 0.74],
                [2, 0, 'Bb2', 2, 0.86], [2, 3, 'Bb2', 1, 0.7], [2, 7, 'F2', 2, 0.8], [2, 10, 'Bb2', 2, 0.8], [2, 14, 'D3', 2, 0.74],
                [3, 0, 'F2', 2, 0.86], [3, 3, 'F3', 1, 0.7], [3, 7, 'F2', 2, 0.8], [3, 10, 'A2', 2, 0.8], [3, 14, 'C3', 2, 0.74],
            ]),
            stab: Phrase::paint([
                [0, 2, $gm, 1, 0.5], [0, 7, $gm, 1, 0.46], [0, 13, $gm, 1, 0.44],
                [1, 2, ['Eb4', 'G4', 'Bb4'], 1, 0.5], [1, 7, ['Eb4', 'G4', 'Bb4'], 1, 0.46], [1, 13, ['Eb4', 'G4', 'Bb4'], 1, 0.44],
                [2, 2, ['Bb3', 'D4', 'F4'], 1, 0.5], [2, 7, ['Bb3', 'D4', 'F4'], 1, 0.46], [2, 13, ['Bb3', 'D4', 'F4'], 1, 0.44],
                [3, 2, $fCh, 1, 0.5], [3, 7, $fCh, 1, 0.46], [3, 13, $fCh, 1, 0.44],
            ]),
            lead: Phrase::paint([
                [0, 2, 'D5', 2, 0.44], [0, 6, 'Bb4', 2, 0.42], [0, 10, 'G4', 4, 0.46],
                [1, 2, 'Eb5', 2, 0.44], [1, 6, 'D5', 2, 0.42], [1, 10, 'Bb4', 4, 0.46],
                [2, 2, 'F5', 2, 0.46], [2, 6, 'D5', 2, 0.42], [2, 10, 'Bb4', 4, 0.46],
                [3, 2, 'C5', 2, 0.44], [3, 6, 'A4', 2, 0.42], [3, 10, 'F4', 4, 0.44],
            ]),
            pad: Phrase::paint([
                [0, 0, $gm7, 16, 0.34],
                [1, 0, $ebMaj7, 16, 0.34],
                [2, 0, ['Bb2', 'D3', 'F3', 'A3'], 16, 0.34],
                [3, 0, ['F3', 'A3', 'C4', 'Eb4'], 16, 0.34],
            ]),
            arp: Phrase::arpCycle([$gm, ['Eb4', 'G4', 'Bb4'], ['Bb3', 'D4', 'F4'], $fCh], 2, 0.2),
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, '.xXx.xXx.xXx.xXx'), 0.14, 0.26),
                'rim' => Phrase::drums([
                    '..x.....x..x....', '..x.....x.......', '..x.....x..x....', '..x.....x..x..x.',
                ], 0.32, 0.45),
            ],
        );

        $tracks[] = new Track(
            id: 'bricks',
            name: 'Bricks',
            detail: '130 breaks',
            kind: 'house',
            bpm: 130.0,
            swing: 0.1,
            mix: ['clap' => 0.6, 'hats' => 0.38, 'stab' => 0.4] + self::BASE_MIX,
            kick: Phrase::drums([
                'x.x.......xx....', 'x.x.......x.....', 'x.x.......xx....', 'x.x.......x..x..',
            ], 0.9, 1.0),
            clap: Phrase::drums([$snareGhost, '....X..x....X...', $snareGhost, '....X..x.x..X.xx'], 0.3, 0.9),
            hat: Phrase::drums([$hat8, $hat8, $hat8, $hat8], 0.36, 0.6),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, $openLo], 0.4, 0.4),
            bass: Phrase::paint([
                [0, 0, 'D2', 6, 0.86], [0, 10, 'D2', 2, 0.78], [0, 13, 'F2', 3, 0.8],
                [1, 0, 'Bb1', 6, 0.86], [1, 10, 'Bb1', 2, 0.78], [1, 13, 'D2', 3, 0.8],
                [2, 0, 'F2', 6, 0.86], [2, 10, 'F2', 2, 0.78], [2, 13, 'A2', 3, 0.8],
                [3, 0, 'C2', 6, 0.86], [3, 10, 'C2', 2, 0.78], [3, 13, 'E2', 3, 0.8],
            ]),
            stab: Phrase::paint([
                [0, 6, $dm, 1, 0.5], [0, 14, $dm, 1, 0.44],
                [1, 6, $bb, 1, 0.5], [1, 14, $bb, 1, 0.44],
                [2, 6, $fCh, 1, 0.5], [2, 14, $fCh, 1, 0.44],
                [3, 6, $cCh, 1, 0.5], [3, 14, $cCh, 1, 0.48],
            ]),
            lead: Phrase::paint([
                [0, 0, 'A4', 2, 0.46], [0, 3, 'F4', 2, 0.42], [0, 6, 'D4', 4, 0.44],
                [1, 0, 'F4', 2, 0.46], [1, 3, 'D4', 2, 0.42], [1, 6, 'Bb3', 4, 0.44],
                [2, 0, 'C5', 2, 0.48], [2, 3, 'A4', 2, 0.44], [2, 6, 'F4', 4, 0.46],
                [3, 0, 'E4', 2, 0.46], [3, 3, 'G4', 2, 0.44], [3, 6, 'C5', 6, 0.48],
            ]),
            pad: Phrase::paint([
                [0, 0, $dm7, 16, 0.32],
                [1, 0, $bbMaj7, 16, 0.32],
                [2, 0, $fMaj7, 16, 0.32],
                [3, 0, $cMaj7, 16, 0.32],
            ]),
            arp: Phrase::arpCycle([$dm, $bb, $fCh, $cCh], 4, 0.26),
            perc: [
                'shaker' => Phrase::drums(array_fill(0, 4, '.x.x.x.x.x.x.x.x'), 0.18, 0.26),
                'congaHi' => Phrase::drums([
                    '..x...x.....x...', '..x...x.....x.x.', '..x...x.....x...', '..x...x..x..x.x.',
                ], 0.32, 0.42),
                'congaLo' => Phrase::drums(array_fill(0, 4, '........x.....x.'), 0.34, 0.4),
            ],
        );

        $tracks[] = new Track(
            id: 'ravetape',
            name: 'Rave Tape',
            detail: '136 acid breaks',
            kind: 'acid',
            bpm: 136.0,
            swing: 0.06,
            mix: ['bass' => 0.86, 'clap' => 0.56, 'hats' => 0.4, 'stab' => 0.3] + self::BASE_MIX,
            kick: Phrase::drums([
                'x.....x...x.....', 'x.....x...x..x..', 'x.....x...x.....', 'x.x...x...x.....',
            ], 0.9, 1.0),
            clap: Phrase::drums([$snareGhost, $snareGhost, $snareGhost, '....X..x.x..X.XX'], 0.3, 0.88),
            hat: Phrase::drums(array_fill(0, 4, 'x.xxx.xxx.xxx.xx'), 0.3, 0.55),
            hatOpen: Phrase::drums([$open, $open, $open, $open], 0.4, 0.4),
            bass: Phrase::paint(self::accentLine([
                0 => [[0, 'E2', 0.95, true], [2, 'E2', 0.7], [3, 'G2', 0.78], [6, 'E3', 0.9, true],
                    [8, 'E2', 0.72], [10, 'D3', 0.8], [11, 'B2', 0.74], [14, 'G2', 0.9, true]],
                1 => [[0, 'E2', 0.95, true], [1, 'E2', 0.7], [4, 'B2', 0.8], [6, 'D3', 0.92, true],
                    [7, 'E3', 0.76], [10, 'E2', 0.72], [12, 'G2', 0.82], [14, 'A2', 0.9, true]],
                2 => [[0, 'C3', 0.95, true], [2, 'C3', 0.7], [3, 'E3', 0.78], [6, 'G3', 0.9, true],
                    [8, 'C3', 0.72], [10, 'B2', 0.8], [12, 'G2', 0.74], [14, 'E2', 0.9, true]],
                3 => [[0, 'D3', 0.95, true], [2, 'D3', 0.72], [4, 'A2', 0.8], [6, 'D3', 0.92, true],
                    [8, 'C3', 0.74], [10, 'B2', 0.8], [12, 'A2', 0.78], [14, 'B2', 0.92, true]],
            ])),
            stab: Phrase::paint([
                [0, 0, $em, 1, 0.46], [1, 0, $em, 1, 0.42],
                [2, 0, $cCh, 1, 0.46], [3, 0, $dMaj, 1, 0.46], [3, 8, $dMaj, 1, 0.42],
            ]),
            lead: Phrase::paint([
                [0, 8, 'B4', 4, 0.4],
                [1, 8, 'D5', 4, 0.4],
                [2, 8, 'E5', 4, 0.42],
                [3, 8, 'F#5', 4, 0.44],
            ]),
            pad: Phrase::paint([
                [0, 0, $eMin7, 16, 0.26],
                [1, 0, $eMin7, 16, 0.26],
                [2, 0, $cMaj7, 16, 0.26],
                [3, 0, $dMaj7, 16, 0.26],
            ]),
            arp: Phrase::arpCycle([$em, $em, $cCh, $dMaj], 3, 0.22),
            perc: [
                'rim' => Phrase::drums([
                    '...x.......x....', '...x.......x....', '...x.......x....', '...x...x...x..x.',
                ], 0.36, 0.5),
                'congaHi' => Phrase::drums(array_fill(0, 4, '..x...x.....x.x.'), 0.38, 0.5),
                'congaLo' => Phrase::drums(array_fill(0, 4, '.......x......x.'), 0.42, 0.52),
            ],
        );

        $tracks[] = new Track(
            id: 'lowtide',
            name: 'Lowtide',
            detail: '172 liquid',
            kind: 'deep',
            bpm: 172.0,
            swing: 0.0,
            mix: [
                'kick' => 0.86, 'clap' => 0.56, 'hats' => 0.3, 'bass' => 0.86,
                'stab' => 0.3, 'lead' => 0.34, 'pad' => 0.5, 'arp' => 0.2,
            ],
            kick: Phrase::drums([$dnbKick, $dnbKick, $dnbKick, 'x.......x.x.....'], 0.92, 1.0),
            clap: Phrase::drums([$clap, '....X.......X..x', $clap, '....X..x....X..x'], 0.3, 0.92),
            hat: Phrase::drums([$hatDnb, $hatDnb, $hatDnb, $hatDnb], 0.28, 0.5),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, $openLo], 0.3, 0.3),
            bass: Phrase::paint([
                [0, 0, 'Eb2', 9, 0.86], [0, 10, 'Bb1', 6, 0.8],
                [1, 0, 'C2', 9, 0.86], [1, 10, 'G1', 6, 0.8],
                [2, 0, 'Ab1', 9, 0.86], [2, 10, 'Eb2', 6, 0.8],
                [3, 0, 'Bb1', 9, 0.86], [3, 10, 'F2', 4, 0.8], [3, 14, 'D2', 2, 0.76],
            ]),
            stab: Phrase::paint([
                [0, 6, ['Eb4', 'G4', 'Bb4', 'D5'], 3, 0.38], [0, 14, ['Eb4', 'G4', 'Bb4', 'D5'], 2, 0.32],
                [1, 6, ['C4', 'Eb4', 'G4', 'Bb4'], 3, 0.38], [1, 14, ['C4', 'Eb4', 'G4', 'Bb4'], 2, 0.32],
                [2, 6, ['Ab3', 'C4', 'Eb4', 'G4'], 3, 0.38], [2, 14, ['Ab3', 'C4', 'Eb4', 'G4'], 2, 0.32],
                [3, 6, ['Bb3', 'D4', 'F4', 'C5'], 3, 0.38], [3, 14, ['Bb3', 'D4', 'F4', 'C5'], 2, 0.34],
            ]),
            lead: Phrase::paint([
                [0, 0, 'G5', 6, 0.36], [0, 8, 'F5', 2, 0.32], [0, 10, 'Eb5', 6, 0.36],
                [1, 0, 'Eb5', 4, 0.34], [1, 4, 'D5', 2, 0.32], [1, 6, 'C5', 10, 0.36],
                [2, 0, 'Eb5', 6, 0.36], [2, 8, 'G5', 8, 0.36],
                [3, 0, 'F5', 8, 0.36], [3, 8, 'D5', 8, 0.34],
            ]),
            pad: Phrase::paint([
                [0, 0, $ebMaj7, 16, 0.48],
                [1, 0, ['C3', 'Eb3', 'G3', 'Bb3'], 16, 0.46],
                [2, 0, $abMaj7, 16, 0.48],
                [3, 0, ['Bb2', 'D3', 'F3', 'C4'], 16, 0.46],
            ]),
            arp: Phrase::arpCycle([
                ['Eb4', 'G4', 'Bb4', 'D5'],
                ['C4', 'Eb4', 'G4', 'Bb4'],
                ['Ab3', 'C4', 'Eb4', 'G4'],
                ['Bb3', 'D4', 'F4', 'C5'],
            ], 2, 0.2),
        );

        $tracks[] = new Track(
            id: 'slipstream',
            name: 'Slipstream',
            detail: '174 liquid',
            kind: 'deep',
            bpm: 174.0,
            swing: 0.0,
            mix: [
                'kick' => 0.86, 'clap' => 0.56, 'hats' => 0.32, 'bass' => 0.86,
                'stab' => 0.26, 'lead' => 0.36, 'pad' => 0.48, 'arp' => 0.22,
            ],
            kick: Phrase::drums([$dnbKick, $dnbKick, $dnbKick, 'x.........x.x...'], 0.92, 1.0),
            clap: Phrase::drums([$clap, '....X..x....X...', $clap, '....X..x....X..x'], 0.3, 0.92),
            hat: Phrase::drums([$hat8, $hatDnb, $hat8, $hatDnb], 0.28, 0.5),
            hatOpen: Phrase::drums([$openLo, $openLo, $openLo, $openLo], 0.3, 0.3),
            bass: Phrase::paint([
                [0, 0, 'A1', 9, 0.86], [0, 10, 'E2', 6, 0.8],
                [1, 0, 'F1', 9, 0.86], [1, 10, 'C2', 6, 0.8],
                [2, 0, 'D2', 9, 0.86], [2, 10, 'A1', 6, 0.8],
                [3, 0, 'E2', 6, 0.86], [3, 6, 'G2', 4, 0.8], [3, 10, 'E2', 6, 0.8],
            ]),
            stab: Phrase::paint([
                [0, 10, ['C4', 'E4', 'G4', 'B4'], 2, 0.32],
                [1, 10, ['F3', 'A3', 'C4', 'E4'], 2, 0.32],
                [2, 10, ['F3', 'C4', 'E4', 'A4'], 2, 0.32],
                [3, 10, ['E3', 'G3', 'B3', 'D4'], 2, 0.34],
            ]),
            lead: Phrase::paint([
                [0, 0, 'E5', 4, 0.38], [0, 4, 'C5', 4, 0.36], [0, 8, 'B4', 8, 0.38],
                [1, 0, 'C5', 4, 0.38], [1, 4, 'A4', 4, 0.36], [1, 8, 'G4', 8, 0.36],
                [2, 0, 'A4', 4, 0.38], [2, 4, 'C5', 4, 0.36], [2, 8, 'D5', 8, 0.38],
                [3, 0, 'B4', 4, 0.38], [3, 4, 'G4', 4, 0.36], [3, 8, 'E5', 8, 0.38],
            ]),
            pad: Phrase::paint([
                [0, 0, $am7, 16, 0.46],
                [1, 0, $fMaj7, 16, 0.44],
                [2, 0, $dm7, 16, 0.46],
                [3, 0, $eMin7, 16, 0.44],
            ]),
            arp: Phrase::arpCycle([
                ['A4', 'C5', 'E5', 'G5'],
                ['F4', 'A4', 'C5', 'E5'],
                ['D4', 'F4', 'A4', 'C5'],
                ['E4', 'G4', 'B4', 'D5'],
            ], 2, 0.22),
        );

        // Display order and grouping, in one list: section, then sub-genre, then track.
        // The UI titles each sub-genre above its first track, so a style's tracks
        // must sit together here.
        $byId = [];
        foreach ($tracks as $track) {
            $byId[$track->id] = $track;
        }
        $ordered = [];
        foreach (self::GROUPS as [$id, $section, $style]) {
            $track = $byId[$id] ?? throw new \LogicException("grouped track is not defined: {$id}");
            $ordered[$id] = $track->grouped($section, $style);
            unset($byId[$id]);
        }
        if ($byId !== []) {
            throw new \LogicException('tracks missing from Library::GROUPS: '.implode(', ', array_keys($byId)));
        }

        return $ordered;
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
     * Turn a bar-keyed table of `[step, pitch, velocity, accent?]` sixteenths into
     * `Phrase::paint` items: the shape `acidBass` uses, for any other acid line.
     *
     * @param  array<int, list<array{0:int, 1:string, 2:float, 3?:bool}>>  $bars
     * @return list<array{0:int, 1:int, 2:string, 3:int, 4:float, 5:bool}>
     */
    private static function accentLine(array $bars): array
    {
        $out = [];
        foreach ($bars as $bar => $notes) {
            foreach ($notes as $note) {
                $out[] = [(int) $bar, $note[0], $note[1], 1, $note[2], $note[3] ?? false];
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
        array $perc = [],
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
            perc: $perc,
        );
    }
}