<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Music\ArrangedTrack;
use App\Support\Music\Library;
use App\Support\Music\Phrase;
use App\Support\Music\Track;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The 16-bar song form, as the README and the Arranger promise it.
 *
 * Intro, Groove, Break, Drop, four bars each. The intro is sparse on purpose (bar 2 is
 * kick and hats, the stab, lead and arp wait for bar 5) and these tests hold that
 * line: an earlier version "fixed" the sparse intro by filling it, and it made the
 * tracks worse. If one of these fails, the arrangement changed, not the test.
 */
final class ArrangementTest extends TestCase
{
    private const NOTE_STEMS = ['bass', 'stab', 'lead', 'pad', 'arp'];

    /** @return iterable<string, array{Track}> */
    public static function tracks(): iterable
    {
        foreach (Library::all() as $track) {
            yield $track->id => [$track];
        }
    }

    public function test_the_library_has_eighteen_tracks_in_three_sections(): void
    {
        $tracks = Library::all();
        $this->assertCount(18, $tracks);
        $this->assertSame(array_keys($tracks), array_values(array_map(fn (Track $t) => $t->id, $tracks)));

        $sections = [];
        foreach ($tracks as $track) {
            $sections[$track->section] = ($sections[$track->section] ?? 0) + 1;
        }
        $this->assertSame(['EDM' => 6, 'Lofi' => 6, 'Breaks' => 6], $sections);
    }

    #[DataProvider('tracks')]
    public function test_track_metadata_is_within_the_engine_ranges(Track $track): void
    {
        $this->assertGreaterThanOrEqual(40, $track->bpm);
        $this->assertLessThanOrEqual(200, $track->bpm);
        $this->assertGreaterThanOrEqual(0, $track->swing);
        $this->assertLessThanOrEqual(1, $track->swing);
        $this->assertSame(Library::STEMS, array_values(array_intersect(Library::STEMS, array_keys($track->mix))));
        foreach ($track->mix as $stem => $level) {
            $this->assertGreaterThanOrEqual(0, $level, $stem);
            $this->assertLessThanOrEqual(1, $level, $stem);
        }
    }

    #[DataProvider('tracks')]
    public function test_every_lane_is_256_steps(Track $track): void
    {
        $arranged = $track->arrange();
        foreach (['kick', 'clap', 'hat', 'hatOpen', ...self::NOTE_STEMS] as $lane) {
            $this->assertCount(Phrase::SONG_STEPS, $arranged->{$lane}, "{$track->id}.{$lane}");
        }
        foreach ($arranged->perc as $instrument => $lane) {
            $this->assertCount(Phrase::SONG_STEPS, $lane, "{$track->id}.perc.{$instrument}");
        }
    }

    #[DataProvider('tracks')]
    public function test_arranging_is_deterministic(Track $track): void
    {
        $this->assertSame($track->arrange()->toJson(), $track->arrange()->toJson());
    }

    #[DataProvider('tracks')]
    public function test_the_intro_withholds_the_stab_lead_and_arp_until_bar_five(Track $track): void
    {
        $arranged = $track->arrange();
        foreach (['stab', 'lead', 'arp'] as $stem) {
            for ($bar = 0; $bar < 4; $bar++) {
                $this->assertNotContains(true, $arranged->barActivity($stem, $bar), "{$track->id}: {$stem} sounds in bar ".($bar + 1));
            }
        }
    }

    #[DataProvider('tracks')]
    public function test_bar_two_is_kick_and_hats_with_no_clap_or_bass(Track $track): void
    {
        $arranged = $track->arrange();
        $this->assertContains(true, $arranged->barActivity('kick', 1), "{$track->id}: no kick in bar 2");
        $this->assertContains(true, $arranged->barActivity('hats', 1), "{$track->id}: no hats in bar 2");
        foreach (['clap', 'bass'] as $stem) {
            $this->assertNotContains(true, $arranged->barActivity($stem, 1), "{$track->id}: {$stem} in bar 2");
        }
    }

    #[DataProvider('tracks')]
    public function test_the_clap_enters_on_the_last_bar_of_the_intro(Track $track): void
    {
        $arranged = $track->arrange();
        for ($bar = 0; $bar < 3; $bar++) {
            $this->assertNotContains(true, $arranged->barActivity('clap', $bar), "{$track->id}: clap in bar ".($bar + 1));
        }
    }

    #[DataProvider('tracks')]
    public function test_the_break_drops_kick_and_clap_except_its_fill(Track $track): void
    {
        $arranged = $track->arrange();
        $breakStart = 8 * Phrase::STEPS_PER_BAR;
        for ($step = $breakStart; $step < $breakStart + Phrase::GROOVE_STEPS; $step++) {
            $this->assertSame(0.0, (float) $arranged->clap[$step], "{$track->id}: clap at step {$step}");
        }
        $kicks = [];
        for ($step = $breakStart; $step < $breakStart + Phrase::GROOVE_STEPS; $step++) {
            if ($arranged->kick[$step] > 0) {
                $kicks[] = $step - $breakStart;
            }
        }
        $this->assertSame([60, 62, 63], $kicks, "{$track->id}: the break's kick should be the two-hit fill");
    }

    #[DataProvider('tracks')]
    public function test_the_break_drops_the_bass_except_on_acid(Track $track): void
    {
        $arranged = $track->arrange();
        $hasBass = false;
        for ($bar = 8; $bar < 11; $bar++) {
            $hasBass = $hasBass || in_array(true, $arranged->barActivity('bass', $bar), true);
        }
        if ($track->kind === 'acid') {
            $this->assertTrue($hasBass, 'acid keeps its bassline through the break');
        } else {
            $this->assertFalse($hasBass, "{$track->id}: bass in the first three bars of the break");
        }
    }

    #[DataProvider('tracks')]
    public function test_the_groove_and_drop_carry_every_stem(Track $track): void
    {
        $arranged = $track->arrange();
        foreach (['Groove' => 4, 'Drop' => 12] as $part => $first) {
            foreach (Library::STEMS as $stem) {
                $this->assertTrue(
                    $this->soundsIn($arranged, $stem, $first, $first + 4),
                    "{$track->id}: {$stem} is missing from the {$part}",
                );
            }
        }
    }

    public function test_bar_activity_matches_the_lanes(): void
    {
        $arranged = Library::findOrFail('warehouse')->arrange();
        for ($bar = 0; $bar < 16; $bar++) {
            $row = $arranged->barActivity('kick', $bar);
            for ($i = 0; $i < 16; $i++) {
                $this->assertSame($arranged->kick[$bar * 16 + $i] > 0, $row[$i]);
            }
        }
    }

    public function test_the_arrangement_serializes_to_the_engine_shape(): void
    {
        $json = Library::findOrFail('rain')->arrange()->jsonSerialize();
        $this->assertSame(
            ['id', 'name', 'detail', 'kind', 'section', 'style', 'bpm', 'swing', 'mix', 'kick', 'clap', 'hat', 'hatOpen', 'bass', 'stab', 'lead', 'pad', 'arp', 'perc'],
            array_keys($json),
        );
        $first = array_values(array_filter($json['pad']))[0];
        $this->assertSame(['notes', 'len', 'vel', 'accent'], array_keys($first->jsonSerialize()));
    }

    private function soundsIn(ArrangedTrack $track, string $stem, int $fromBar, int $toBar): bool
    {
        for ($bar = $fromBar; $bar < $toBar; $bar++) {
            if (in_array(true, $track->barActivity($stem, $bar), true)) {
                return true;
            }
        }

        return false;
    }
}
