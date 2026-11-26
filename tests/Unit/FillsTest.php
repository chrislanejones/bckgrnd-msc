<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Music\Fills;
use App\Support\Music\Library;
use App\Support\Music\Phrase;
use PHPUnit\Framework\TestCase;

/**
 * The one-bar fills exported with every track. The engine plays them as written, so
 * this is where "restrained" and "only the drum lanes" are held.
 */
final class FillsTest extends TestCase
{
    public function test_every_track_exports_one_fill_of_four_one_bar_drum_lanes(): void
    {
        foreach (Library::all() as $track) {
            $json = json_decode($track->arrange()->toJson(), true);
            $this->assertCount(1, $json['fills'], $track->id);
            $fill = $json['fills'][0];
            $this->assertSame(['id', 'name', ...Fills::LANES], array_keys($fill), $track->id);
            foreach (Fills::LANES as $lane) {
                $this->assertCount(Fills::BAR, $fill[$lane], "{$track->id} {$lane}");
                foreach ($fill[$lane] as $vel) {
                    $this->assertTrue($vel >= 0 && $vel <= 1, "{$track->id} {$lane} velocity {$vel}");
                }
            }
        }
    }

    public function test_a_fill_is_the_tracks_own_last_groove_bar_changed_only_on_its_last_beat(): void
    {
        foreach (Library::all() as $track) {
            $fill = Fills::forTrack($track)[0];
            $changed = false;
            foreach (Fills::LANES as $lane) {
                $groove = array_slice($track->{$lane}, Phrase::GROOVE_STEPS - Fills::BAR, Fills::BAR);
                for ($step = 0; $step < Fills::BAR; $step++) {
                    if ((float) $groove[$step] !== $fill[$lane][$step]) {
                        $this->assertGreaterThanOrEqual(11, $step, "{$track->id} {$lane} changes only near the end of the bar");
                        $changed = true;
                    }
                }
            }
            $this->assertTrue($changed, "{$track->id}'s fill differs from its groove");
        }
    }

    public function test_the_style_picks_the_recipe(): void
    {
        $ids = [];
        foreach (Library::all() as $track) {
            $ids[$track->kind][] = Fills::forTrack($track)[0]['id'];
        }
        $this->assertSame(['roll'], array_values(array_unique($ids['house'])));
        $this->assertSame(['roll'], array_values(array_unique($ids['acid'])));
        $this->assertSame(['space'], array_values(array_unique($ids['deep'])));
        $this->assertSame(['ghost'], array_values(array_unique($ids['lofi'])));
    }

    // ---- Fill styles (Night 9) ------------------------------------------------------

    public function test_every_track_has_four_styles_in_order_each_four_one_bar_lanes(): void
    {
        foreach (Library::all() as $track) {
            $styles = Fills::styles($track);
            $this->assertSame(Fills::STYLES, array_column($styles, 'style'), $track->id);
            $this->assertSame(['Simple', 'Busy', 'Syncopated'], array_column(array_slice($styles, 1), 'name'), $track->id);
            foreach ($styles as $fill) {
                $this->assertSame(['id', 'name', 'style', ...Fills::LANES], array_keys($fill), "{$track->id} {$fill['style']}");
                foreach (Fills::LANES as $lane) {
                    $this->assertCount(Fills::BAR, $fill[$lane], "{$track->id} {$fill['style']} {$lane}");
                    foreach ($fill[$lane] as $vel) {
                        $this->assertIsFloat($vel);
                        $this->assertTrue($vel >= 0 && $vel <= 1, "{$track->id} {$fill['style']} {$lane} velocity {$vel}");
                    }
                }
            }
        }
    }

    public function test_classic_is_mains_fill_byte_for_byte_and_the_tracks_own_fill_is_unchanged(): void
    {
        $main = json_decode((string) file_get_contents(__DIR__.'/../fixtures/fills/classic.json'), true);
        $this->assertCount(count(Library::all()), $main);
        foreach (Library::all() as $track) {
            $classic = Fills::styles($track)[0];
            $this->assertSame('classic', $classic['style']);
            unset($classic['style']);
            $this->assertSame(json_encode($main[$track->id]), json_encode($classic), $track->id);
            // The track's own `fills`, part of a saved project's hashed source, is still
            // exactly main's one fill.
            $json = json_decode($track->arrange()->toJson(), true);
            $this->assertSame(json_encode([$main[$track->id]]), json_encode($json['fills']), $track->id);
        }
    }

    public function test_each_style_changes_only_the_second_half_of_the_groove_bar_and_differs_from_classic(): void
    {
        foreach (Library::all() as $track) {
            $styles = Fills::styles($track);
            foreach (array_slice($styles, 1) as $fill) {
                $fromGroove = false;
                $fromClassic = false;
                foreach (Fills::LANES as $lane) {
                    $groove = array_slice($track->{$lane}, Phrase::GROOVE_STEPS - Fills::BAR, Fills::BAR);
                    for ($step = 0; $step < Fills::BAR; $step++) {
                        if ((float) $groove[$step] !== $fill[$lane][$step]) {
                            $this->assertGreaterThanOrEqual(8, $step, "{$track->id} {$fill['style']} {$lane} changes only in the second half");
                            $fromGroove = true;
                        }
                        $fromClassic = $fromClassic || $styles[0][$lane][$step] !== $fill[$lane][$step];
                    }
                }
                $this->assertTrue($fromGroove, "{$track->id} {$fill['style']} differs from the groove");
                $this->assertTrue($fromClassic, "{$track->id} {$fill['style']} differs from Classic");
            }
            $this->assertCount(4, array_unique(array_map(
                fn (array $f): string => (string) json_encode(array_intersect_key($f, array_flip(Fills::LANES))),
                $styles,
            )), "{$track->id}: four different fills");
        }
    }

    public function test_no_style_is_louder_than_the_tracks_own_peak_in_each_lane(): void
    {
        foreach (Library::all() as $track) {
            foreach (array_slice(Fills::styles($track), 1) as $fill) {
                foreach (Fills::LANES as $lane) {
                    $peak = (float) max($track->{$lane});
                    $this->assertLessThanOrEqual($peak, max($fill[$lane]), "{$track->id} {$fill['style']} {$lane} peak {$peak}");
                }
            }
        }
    }

    public function test_styles_keep_to_their_sketch(): void
    {
        foreach (Library::all() as $track) {
            [$classic, $simple, $busy, $sync] = Fills::styles($track);
            $groove = [];
            foreach (Fills::LANES as $lane) {
                $groove[$lane] = array_map('floatval', array_slice($track->{$lane}, Phrase::GROOVE_STEPS - Fills::BAR, Fills::BAR));
            }
            // Simple: kick and clap as written; no closed hat after step 12.
            $this->assertSame($groove['kick'], $simple['kick'], "{$track->id} simple kick");
            $this->assertSame($groove['clap'], $simple['clap'], "{$track->id} simple clap");
            $this->assertSame([0.0, 0.0, 0.0], array_slice($simple['hat'], 13, 3), "{$track->id} simple hats");
            $this->assertGreaterThan(0.0, $simple['hatOpen'][14], "{$track->id} simple open hat");
            // Busy: the kick on 8 and 12 only in the second half, a rising clap roll to
            // the downbeat, no hats under it.
            $kicks = array_keys(array_filter(array_slice($busy['kick'], 8, 8, true)));
            $this->assertSame([8, 12], $kicks, "{$track->id} busy kick");
            $roll = array_slice($busy['clap'], 12, 4);
            $sorted = $roll;
            sort($sorted);
            $this->assertSame($sorted, $roll, "{$track->id} busy roll rises");
            $this->assertSame([0.0, 0.0, 0.0, 0.0], array_slice($busy['hat'], 12, 4), "{$track->id} busy hats");
            // Syncopated: kick on 8, 11 and 14; claps on 10, 13 and 15; the 12 backbeat out.
            $this->assertSame([8, 11, 14], array_keys(array_filter(array_slice($sync['kick'], 8, 8, true))), "{$track->id} syncopated kick");
            $this->assertSame([10, 13, 15], array_keys(array_filter(array_slice($sync['clap'], 9, 7, true))), "{$track->id} syncopated clap");
            $this->assertSame([10], array_keys(array_filter(array_slice($sync['hatOpen'], 8, 8, true))), "{$track->id} syncopated open hat");
        }
    }

    public function test_styles_are_deterministic(): void
    {
        foreach (Library::all() as $track) {
            $this->assertSame(json_encode(Fills::styles($track)), json_encode(Fills::styles($track)), $track->id);
        }
    }

    // ---- Beat fills (Night 10) ------------------------------------------------------

    public function test_every_track_has_four_beat_fills_in_style_order_each_four_one_bar_lanes(): void
    {
        foreach (Library::all() as $track) {
            $beats = Fills::beatStyles($track);
            $this->assertSame(Fills::STYLES, array_column($beats, 'style'), $track->id);
            $this->assertSame(['classic-beat', 'simple-beat', 'busy-beat', 'syncopated-beat'], array_column($beats, 'id'), $track->id);
            foreach ($beats as $fill) {
                $this->assertSame(['id', 'name', 'style', ...Fills::LANES], array_keys($fill), "{$track->id} {$fill['id']}");
                foreach (Fills::LANES as $lane) {
                    $this->assertCount(Fills::BAR, $fill[$lane], "{$track->id} {$fill['id']} {$lane}");
                    foreach ($fill[$lane] as $vel) {
                        $this->assertIsFloat($vel);
                        $this->assertTrue($vel >= 0 && $vel <= 1, "{$track->id} {$fill['id']} {$lane} velocity {$vel}");
                    }
                }
            }
        }
    }

    public function test_a_beat_fill_has_every_hit_on_the_last_beat(): void
    {
        foreach (Library::all() as $track) {
            foreach (Fills::beatStyles($track) as $fill) {
                $hits = 0;
                foreach (Fills::LANES as $lane) {
                    $this->assertSame(array_fill(0, Fills::BEAT_FROM, 0.0), array_slice($fill[$lane], 0, Fills::BEAT_FROM), "{$track->id} {$fill['id']} {$lane}: silent before step 12");
                    $hits += count(array_filter(array_slice($fill[$lane], Fills::BEAT_FROM)));
                }
                $this->assertGreaterThan(0, $hits, "{$track->id} {$fill['id']} plays something");
            }
        }
    }

    public function test_the_four_beat_fills_differ_and_are_not_the_bar_fills_cut_short(): void
    {
        foreach (Library::all() as $track) {
            $beats = Fills::beatStyles($track);
            $last = fn (array $f): string => (string) json_encode(array_map(
                fn (string $lane): array => array_slice($f[$lane], Fills::BEAT_FROM),
                Fills::LANES,
            ));
            $this->assertCount(4, array_unique(array_map($last, $beats)), "{$track->id}: four different beat fills");
            foreach (Fills::styles($track) as $i => $bar) {
                $this->assertNotSame($last($bar), $last($beats[$i]), "{$track->id} {$bar['style']}: written for the beat, not the bar fill's last beat");
            }
        }
    }

    public function test_no_beat_fill_is_louder_than_the_tracks_own_peak_in_each_lane(): void
    {
        foreach (Library::all() as $track) {
            foreach (Fills::beatStyles($track) as $fill) {
                foreach (Fills::LANES as $lane) {
                    $peak = (float) max($track->{$lane});
                    $this->assertLessThanOrEqual($peak, max($fill[$lane]), "{$track->id} {$fill['id']} {$lane} peak {$peak}");
                }
            }
        }
    }

    public function test_beat_fills_keep_to_their_sketch(): void
    {
        $on = fn (array $lane): array => array_keys(array_filter($lane));
        foreach (Library::all() as $track) {
            [$classic, $simple, $busy, $sync] = Fills::beatStyles($track);
            // Classic: a clap pickup on 14 and 15 over the beat's kick.
            $this->assertSame([14, 15], $on($classic['clap']), "{$track->id} classic clap");
            $this->assertSame([12], $on($classic['kick']), "{$track->id} classic kick");
            $this->assertLessThan($classic['clap'][15], $classic['clap'][14], "{$track->id} classic rises");
            // Simple: one accent, kick and clap on the beat, nothing else.
            $this->assertSame([12], $on($simple['clap']), "{$track->id} simple clap");
            $this->assertSame([12], $on($simple['kick']), "{$track->id} simple kick");
            $this->assertSame([], [...$on($simple['hat']), ...$on($simple['hatOpen'])], "{$track->id} simple hats");
            // Busy: a sixteenth clap roll, rising, three or four hits.
            $roll = array_values(array_filter($busy['clap']));
            $sorted = $roll;
            sort($sorted);
            $this->assertSame($sorted, $roll, "{$track->id} busy roll rises");
            $this->assertGreaterThanOrEqual(3, count($roll), "{$track->id} busy roll");
            $this->assertSame(range(16 - count($roll), 15), $on($busy['clap']), "{$track->id} busy roll is in sixteenths up to the downbeat");
            // Syncopated: the kick off the beat on 14, claps on 13 and 15, none on 12.
            $this->assertSame([14], $on($sync['kick']), "{$track->id} syncopated kick");
            $this->assertSame([13, 15], $on($sync['clap']), "{$track->id} syncopated clap");
        }
    }

    public function test_beat_fills_are_deterministic_and_leave_the_track_alone(): void
    {
        $main = json_decode((string) file_get_contents(__DIR__.'/../fixtures/fills/classic.json'), true);
        foreach (Library::all() as $track) {
            $this->assertSame(json_encode(Fills::beatStyles($track)), json_encode(Fills::beatStyles($track)), $track->id);
            $json = json_decode($track->arrange()->toJson(), true);
            $this->assertSame(json_encode([$main[$track->id]]), json_encode($json['fills']), $track->id);
        }
    }
}
