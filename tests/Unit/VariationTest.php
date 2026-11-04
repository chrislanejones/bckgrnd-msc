<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Music\Library;
use App\Support\Project\Patterns;
use App\Support\Project\Variation;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Constrained variation: seeded, inside its range, respectful of locks and anchors,
 * and honest about what a melodic lane can and cannot vary.
 */
final class VariationTest extends TestCase
{
    private const NO_LOCKS = ['lanes' => [], 'events' => []];

    private static function source(string $lane, string $track = 'warehouse'): array
    {
        return Patterns::factory(Library::findOrFail($track)->arrange(), $lane);
    }

    /** @return array<string, array{string}> */
    public static function editableLanes(): array
    {
        return ['kick' => ['kick'], 'clap' => ['clap'], 'hat' => ['hat'], 'hatOpen' => ['hatOpen'], 'bass' => ['bass'], 'lead' => ['lead']];
    }

    #[DataProvider('editableLanes')]
    public function test_the_same_seed_gives_the_same_candidate(string $lane): void
    {
        $src = self::source($lane);
        $a = Variation::generate($src, 128, 191, 'moderate', 42, self::NO_LOCKS);
        $b = Variation::generate($src, 128, 191, 'moderate', 42, self::NO_LOCKS);
        $this->assertSame('ok', $a['status']);
        $this->assertSame(json_encode($a), json_encode($b));
        $this->assertSame(Variation::GENERATOR, $a['candidate']['origin']['generator']);
        $this->assertSame(42, $a['candidate']['origin']['seed']);
        $this->assertSame(Patterns::sourceHash($src, 128, 191), $a['candidate']['origin']['sourceHash']);
    }

    public function test_different_seeds_give_different_takes(): void
    {
        $src = self::source('hat');
        $seen = [];
        foreach ([1, 2, 3, 4, 5] as $seed) {
            $seen[] = json_encode(Variation::generate($src, 128, 191, 'adventurous', $seed, self::NO_LOCKS)['candidate']['events']);
        }
        $this->assertGreaterThan(1, count(array_unique($seen)));
    }

    #[DataProvider('editableLanes')]
    public function test_nothing_outside_the_range_changes_and_the_result_reads_back(string $lane): void
    {
        $src = self::source($lane);
        foreach (array_keys(Variation::STRENGTHS) as $strength) {
            $out = Variation::generate($src, 128, 191, $strength, 7, self::NO_LOCKS)['candidate'];
            $outside = fn (array $p) => array_values(array_filter($p['events'], fn ($e) => $e['step'] < 128 || $e['step'] > 191));
            $this->assertSame(json_encode($outside($src)), json_encode($outside($out)), "{$lane} {$strength}");
            // A candidate is a valid pattern: the strict reader takes it back.
            $read = Patterns::readPattern(json_decode((string) json_encode($out), true), $lane, 'candidate');
            $this->assertSame($src['revision'] + 1, $read['revision']);
        }
    }

    public function test_a_locked_lane_is_refused_and_locked_hits_are_untouched(): void
    {
        $src = self::source('bass');
        $locked = Variation::generate($src, 128, 191, 'adventurous', 3, ['lanes' => ['bass'], 'events' => []]);
        $this->assertSame('unavailable', $locked['status']);

        $hats = self::source('hat');
        $ids = array_map(fn ($e) => $e['id'], array_values(array_filter($hats['events'], fn ($e) => $e['step'] >= 128 && $e['step'] <= 191)));
        $this->assertNotEmpty($ids);
        foreach ([1, 2, 3, 4, 5, 6] as $seed) {
            $out = Variation::generate($hats, 128, 191, 'adventurous', $seed, ['lanes' => [], 'events' => ['hat' => $ids]])['candidate'];
            $byId = [];
            foreach ($out['events'] as $e) {
                $byId[$e['id']] = $e;
            }
            foreach ($hats['events'] as $e) {
                if (in_array($e['id'], $ids, true)) {
                    $this->assertSame($e, $byId[$e['id']] ?? null, "locked {$e['id']} seed {$seed}");
                }
            }
        }
    }

    public function test_anchors_keep_their_place_and_level(): void
    {
        $kick = self::source('kick');
        foreach ([1, 2, 3, 4, 5, 6, 7, 8] as $seed) {
            $out = Variation::generate($kick, 128, 191, 'adventurous', $seed, self::NO_LOCKS)['candidate'];
            $after = [];
            foreach ($out['events'] as $e) {
                $after[$e['step']] = $e['vel'];
            }
            foreach ($kick['events'] as $e) {
                if ($e['step'] >= 128 && $e['step'] <= 191 && $e['step'] % 4 === 0) {
                    $this->assertSame($e['vel'], $after[$e['step']] ?? null, "kick on {$e['step']}, seed {$seed}");
                }
            }
        }
    }

    public function test_a_closed_hat_is_never_added_on_an_open_one(): void
    {
        $track = Library::findOrFail('warehouse')->arrange();
        $hat = Patterns::factory($track, 'hat');
        $open = Patterns::factory($track, 'hatOpen');
        $openSteps = array_flip(array_map(fn ($e) => $e['step'], $open['events']));
        $before = array_flip(array_map(fn ($e) => $e['step'], $hat['events']));
        foreach (range(1, 10) as $seed) {
            $out = Variation::generate($hat, 0, 255, 'adventurous', $seed, self::NO_LOCKS, ['hatOpen' => $open])['candidate'];
            foreach ($out['events'] as $e) {
                if (! isset($before[$e['step']])) {
                    $this->assertArrayNotHasKey($e['step'], $openSteps, "seed {$seed}");
                }
            }
        }
    }

    public function test_melodic_variation_keeps_every_pitch_and_says_why(): void
    {
        $src = self::source('bass');
        $pitches = fn (array $p) => array_values(array_unique(array_merge(...array_map(fn ($e) => $e['notes'], $p['events']))));
        foreach ([1, 2, 3, 4] as $seed) {
            $res = Variation::generate($src, 128, 191, 'adventurous', $seed, self::NO_LOCKS);
            $this->assertSame('rhythm', $res['mode']);
            $this->assertSame(Variation::RHYTHM_ONLY, $res['reason']);
            $before = $pitches($src);
            $after = $pitches($res['candidate']);
            sort($before);
            sort($after);
            // Dropping a note may lose a pitch, never invent one.
            $this->assertSame([], array_values(array_diff($after, $before)));
        }
    }

    public function test_bad_ranges_and_read_only_lanes_are_unavailable(): void
    {
        $this->assertSame('unavailable', Variation::generate(self::source('kick'), 3, 40, 'subtle', 1, self::NO_LOCKS)['status']);
        $this->assertSame('unavailable', Variation::generate(self::source('pad'), 0, 63, 'subtle', 1, self::NO_LOCKS)['status']);
    }
}
