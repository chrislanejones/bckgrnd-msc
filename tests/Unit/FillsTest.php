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
}
