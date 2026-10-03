<?php

declare(strict_types=1);

/**
 * Musical checks on the arranged output.
 *
 * `compare-with-original.php` proves the port still matches the original. This checks
 * the things that match cannot catch on its own: that no bar is silent outright, that
 * every stem sounds somewhere in the song, and that the arrangement has its sections.
 *
 * It deliberately does *not* require every bar to be full. An earlier version of this
 * file required four stems per bar, on the theory that a thin bar "reads as a broken
 * stem". That was wrong: the intro's sparseness is deliberate, and filling it in made
 * the tracks sound worse. The bar must be *musically* thin, not absent.
 *
 * Usage: php tools/check-arrangement.php
 */

use App\Support\Music\Library;
use App\Support\Music\Phrase;

require __DIR__.'/../app/Support/Music/Pitch.php';
require __DIR__.'/../app/Support/Music/NoteEvent.php';
require __DIR__.'/../app/Support/Music/Phrase.php';
require __DIR__.'/../app/Support/Music/Track.php';
require __DIR__.'/../app/Support/Music/ArrangedTrack.php';
require __DIR__.'/../app/Support/Music/Arranger.php';
require __DIR__.'/../app/Support/Music/Library.php';

/** Section name for a bar index (0-based). */
function sectionFor(int $bar): string
{
    return match (intdiv($bar, 4)) {
        0 => 'Intro',
        1 => 'Groove',
        2 => 'Break',
        default => 'Drop',
    };
}

/**
 * Minimum number of stems that must sound in any bar.
 *
 * Two: enough that the bar is still music. The intro thins to kick and hats on
 * purpose and the break bottoms out around the same, and a stricter floor pushed the
 * arrangement away from the original without improving how it sounded.
 */
const MIN_STEMS_PER_BAR = 2;

/**
 * Which stems are *sounding* in a bar.
 *
 * Not the same as "has a hit in this bar": a melodic stem with a long gate — the acid
 * pad is a single 64-step note — keeps sounding for bars after its onset without a
 * fresh hit, and counting only onsets would report it as absent. Note spans are
 * therefore measured from their onset to the end of their gate.
 *
 * @return array<string, bool>
 */
function stemsInBar(App\Support\Music\ArrangedTrack $track, int $bar): array
{
    $from = $bar * Phrase::STEPS_PER_BAR;
    $to = $from + Phrase::STEPS_PER_BAR;
    $on = [];

    foreach (Library::STEMS as $stem) {
        if (in_array(true, $track->barActivity($stem, $bar), true)) {
            $on[$stem] = true;

            continue;
        }

        $on[$stem] = false;
        if (! in_array($stem, Library::MUSIC, true)) {
            continue;
        }

        $lane = $track->{$stem};
        // Look back far enough for the longest gate in the library.
        for ($step = max(0, $from - 64); $step < $to; $step++) {
            $event = $lane[$step] ?? null;
            if ($event === null) {
                continue;
            }
            if ($step + max(1, (int) $event->len) > $from) {
                $on[$stem] = true;

                break;
            }
        }
    }

    return $on;
}

$problems = [];
$warnings = [];

foreach (Library::all() as $track) {
    $arranged = $track->arrange();

    $perBar = [];
    for ($bar = 0; $bar < 16; $bar++) {
        $on = stemsInBar($arranged, $bar);
        $perBar[$bar] = $on;
        $count = count(array_filter($on));

        if ($count < MIN_STEMS_PER_BAR) {
            $problems[] = sprintf(
                '%s bar %2d (%-6s) has only %d stems sounding — reads as a broken stem, not a sparse section',
                $track->id,
                $bar + 1,
                sectionFor($bar),
                $count,
            );
        }

        if ($count === 0) {
            $problems[] = "{$track->id} bar ".($bar + 1).' is completely silent';
        }
    }

    // The build has to be a build: the intro must gain parts as it goes, and it must
    // hand over to the groove complete.
    $introCounts = [];
    for ($bar = 0; $bar < 4; $bar++) {
        $introCounts[] = count(array_filter($perBar[$bar]));
    }

    // The last intro bar introduces the full arrangement before the groove takes over,
    // so its stem count should never exceed the groove's. This caught a genuine bug
    // while the arrangement was being reworked, so the check stays — but it guards
    // against a botched edit, not against a deliberately thin intro.
    $grooveCount = count(array_filter($perBar[4]));
    if ($introCounts[3] > $grooveCount) {
        $problems[] = sprintf(
            '%s: the last intro bar has %d stems but the groove has only %d',
            $track->id,
            $introCounts[3],
            $grooveCount,
        );
    }

    for ($i = 1; $i < 4; $i++) {
        if ($introCounts[$i] < $introCounts[$i - 1]) {
            $warnings[] = sprintf(
                '%s: intro bar %d has fewer stems than bar %d (%d vs %d)',
                $track->id,
                $i + 1,
                $i,
                $introCounts[$i],
                $introCounts[$i - 1],
            );
        }
    }

    // The drop is the payoff and should be full.
    for ($bar = 12; $bar < 16; $bar++) {
        $missing = array_keys(array_filter($perBar[$bar], static fn (bool $on): bool => ! $on));
        if ($missing !== []) {
            $warnings[] = sprintf('%s: drop bar %d is missing %s', $track->id, $bar - 11, implode(', ', $missing));
        }
    }

    // No stem may be silent for the whole song. This is the check that would have
    // caught the original complaint directly.
    foreach (Library::STEMS as $stem) {
        $anywhere = false;
        for ($bar = 0; $bar < 16 && ! $anywhere; $bar++) {
            $anywhere = $perBar[$bar][$stem];
        }
        if (! $anywhere) {
            $problems[] = "{$track->id}: stem {$stem} never sounds anywhere in the song";
        }
    }

    // The first bar must not open with an empty fader on most of the kit.
    $first = count(array_filter($perBar[0]));
    if ($first < 3) {
        $warnings[] = "{$track->id}: bar 1 opens with only {$first} stems";
    }
}

if ($problems !== []) {
    fwrite(STDERR, sprintf("%d arrangement problem(s):\n", count($problems)));
    foreach ($problems as $p) {
        fwrite(STDERR, "  {$p}\n");
    }

    exit(1);
}

printf(
    "OK: %d tracks x 16 bars — every bar carries at least %d stems, every stem sounds, no silent bars.\n",
    count(Library::all()),
    MIN_STEMS_PER_BAR,
);

if ($warnings !== []) {
    printf("\n%d warning(s):\n", count($warnings));
    foreach ($warnings as $w) {
        printf("  %s\n", $w);
    }
}