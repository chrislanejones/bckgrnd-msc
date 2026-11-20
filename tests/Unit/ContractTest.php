<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Music\Library;
use App\Support\Project\Contract;
use App\Support\Project\Patterns;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The parameter registry and the project format.
 *
 * The fixtures in tests/fixtures/contract are shared with the TypeScript reader:
 * `tools/check-contract.mjs` runs `migrateProject()` against the same inputs and
 * expects the same outputs, so PHP and the UI cannot read a project differently.
 */
final class ContractTest extends TestCase
{
    public function test_the_registry_lists_the_library_stems_in_order(): void
    {
        $this->assertSame(Library::STEMS, Contract::registry()['stems']);
        $this->assertSame('bckgrnd-msc/parameters', Contract::registry()['contract']);
    }

    public function test_parameter_ids_are_unique_and_well_formed(): void
    {
        $ids = array_column(Contract::registry()['parameters'], 'id');
        $this->assertSame($ids, array_unique($ids));
        foreach ($ids as $id) {
            $this->assertMatchesRegularExpression('/^(transport|master|fx|performance)\.[a-z][A-Za-z]*$/', $id);
        }
    }

    public function test_every_default_is_inside_its_range(): void
    {
        foreach ([...Contract::registry()['parameters'], ...Contract::registry()['stemParameters']] as $p) {
            $this->assertContains($p['scope'], ['project', 'performance'], $p['id']);
            $this->assertContains($p['kind'], ['continuous', 'enum', 'toggle'], $p['id']);
            if ($p['default'] === 'track') {
                continue;
            }
            if ($p['default'] === 'stem') {
                $this->assertSame(Library::STEMS, array_keys($p['defaults']), $p['id']);
                foreach ($p['defaults'] as $stem => $value) {
                    $this->assertTrue($p['min'] <= $value && $value <= $p['max'], "{$p['id']}.{$stem}");
                }

                continue;
            }
            match ($p['kind']) {
                'continuous' => $this->assertTrue($p['min'] <= $p['default'] && $p['default'] <= $p['max'], $p['id']),
                'enum' => $this->assertContains($p['default'], array_column($p['options'], 'value'), $p['id']),
                'toggle' => $this->assertIsBool($p['default'], $p['id']),
            };
            if (isset($p['control'])) {
                $this->assertGreaterThanOrEqual($p['min'], $p['control']['min'], $p['id']);
                $this->assertLessThanOrEqual($p['max'], $p['control']['max'], $p['id']);
            }
        }
    }

    public function test_every_track_tempo_fits_the_tempo_control(): void
    {
        $control = Contract::parameter('transport.bpm')['control'];
        foreach (Library::all() as $track) {
            $this->assertGreaterThanOrEqual($control['min'], $track->bpm, $track->id);
            $this->assertLessThanOrEqual($control['max'], $track->bpm, $track->id);
        }
    }

    public function test_a_fresh_project_is_the_track_as_written(): void
    {
        $track = Library::findOrFail('tunnel');
        $project = Contract::fromTrack($track);

        $this->assertSame($track->bpm, $project['params']['transport.bpm']);
        $this->assertSame($track->swing, $project['params']['transport.swing']);
        $this->assertSame(0.78, $project['params']['master.level']);
        $this->assertSame(Contract::SCENE_SLOTS, array_column($project['scenes']['slots'], 'slot'));
        $this->assertSame((float) $track->mix['bass'], $project['stems']['bass']['volume']);
        $this->assertArrayNotHasKey('performance.loopBars', $project['params'], 'performance gestures are not saved');
        $this->assertEquals($project, Contract::migrate(json_decode(json_encode($project), true)), 'a fresh project round-trips');
    }

    public function test_a_scene_holds_every_effect_and_nothing_else(): void
    {
        $effects = array_values(array_filter(
            array_column(Contract::projectParameters(), 'id'),
            static fn (string $id): bool => str_starts_with($id, 'fx.'),
        ));
        $scene = Contract::sceneParameterIds();
        sort($effects);
        sort($scene);
        $this->assertSame($effects, $scene, 'a scene holds every fx parameter');
        foreach (['transport.bpm', 'transport.swing', 'master.level'] as $outside) {
            $this->assertNotContains($outside, Contract::sceneParameterIds(), "{$outside} stays outside scenes");
        }
        $this->assertSame(Contract::SCENE_SLOTS, Contract::scenesContract()['slots']);
        $this->assertSame(Contract::SCENE_SLOTS, array_column(Contract::scenesContract()['factory'], 'id'));
    }

    public function test_factory_scenes_are_complete_and_read_back_for_every_track(): void
    {
        foreach (Library::all() as $track) {
            $scenes = json_decode((string) json_encode(Contract::factoryScenes($track)), true);
            $this->assertEquals($scenes, json_decode((string) json_encode(Contract::readScenes($scenes)), true), $track->id);
        }
    }

    public function test_drop_returns_without_turning_anything_up(): void
    {
        foreach (Library::all() as $track) {
            $drop = Contract::factoryScene($track, 'drop', 'drop');
            foreach (Library::STEMS as $stem) {
                $this->assertLessThanOrEqual((float) ($track->mix[$stem] ?? 0.8), $drop['stems'][$stem]['volume'], "{$track->id} {$stem}");
                $this->assertFalse($drop['stems'][$stem]['muted'], "{$track->id} {$stem} plays in the drop");
            }
            $this->assertSame(1.0, $drop['params']['fx.filter'], 'the drop opens the filter');
        }
    }

    public function test_sparse_and_build_follow_their_recipes(): void
    {
        $track = Library::findOrFail('warehouse');
        $sparse = Contract::factoryScene($track, 'sparse', 'sparse');
        foreach (['kick', 'clap', 'stab', 'lead', 'arp'] as $out) {
            $this->assertTrue($sparse['stems'][$out]['muted'], "{$out} steps out of the breakdown");
        }
        foreach (['hats', 'bass', 'pad'] as $in) {
            $this->assertFalse($sparse['stems'][$in]['muted'], "{$in} carries the breakdown");
        }
        $build = Contract::factoryScene($track, 'build', 'build');
        $this->assertEqualsWithDelta($track->mix['bass'] * 0.45, $build['stems']['bass']['volume'], 1e-9, 'build pulls the bass down');
        $this->assertSame($track->mix['hats'], $build['stems']['hats']['volume'], 'build keeps the hats');
        $this->assertLessThan(1.0, $build['params']['fx.filter'], 'build darkens');
    }

    public function test_migrating_version_1_adds_scenes_and_changes_nothing_else(): void
    {
        $v1 = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/contract/v1-sparse.input.json'), true);
        $v2 = Contract::migrate($v1);
        $this->assertSame(Contract::VERSION, $v2['version']);
        $this->assertSame(0.4, $v2['params']['fx.filter'], 'the working mix is kept');
        $this->assertTrue($v2['stems']['kick']['muted'], 'the working mix is kept');
        $this->assertEquals(Contract::factoryScenes(Library::findOrFail('rain')), $v2['scenes']);
        $this->assertArrayNotHasKey('activeScene', $v2, 'no scene is applied or remembered as active');
    }

    /** @return iterable<string, array{string}> */
    public static function fixtures(): iterable
    {
        foreach (glob(dirname(__DIR__).'/fixtures/contract/*.input.json') ?: [] as $input) {
            yield basename($input, '.input.json') => [$input];
        }
    }

    #[DataProvider('fixtures')]
    public function test_migration_matches_the_shared_fixture(string $input): void
    {
        $expected = json_decode((string) file_get_contents(str_replace('.input.json', '.expected.json', $input)), true);

        try {
            $actual = Contract::migrate(json_decode((string) file_get_contents($input), true));
        } catch (\InvalidArgumentException $e) {
            $actual = ['error' => $e->getMessage()];
        }

        $this->assertEquals($expected, json_decode((string) json_encode($actual), true));
    }

    public function test_migrating_version_2_to_3_changes_nothing_that_plays(): void
    {
        $v2 = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/contract/v2-captured.input.json'), true);
        $v3 = json_decode((string) json_encode(Contract::migrate($v2)), true);
        $this->assertSame(Contract::VERSION, $v3['version'], 'carried all the way to the current version');
        $this->assertSame([], $v3['patterns'], 'no lane is overridden: every lane plays the factory pattern');
        $this->assertSame(['lanes' => [], 'events' => []], $v3['locks']);
        foreach (['params', 'stems'] as $key) {
            $this->assertEquals($v2[$key], $v3[$key], "{$key} unchanged");
        }
        foreach ($v3['scenes']['slots'] as $i => $scene) {
            $this->assertSame([], $scene['patterns'], 'a migrated scene sets no lanes, so launching it leaves patterns alone');
            $this->assertEquals($v2['scenes']['slots'][$i]['stems'], $scene['stems']);
        }
    }

    public function test_migrating_version_3_to_4_states_crash_off_and_changes_nothing_else(): void
    {
        $path = dirname(__DIR__).'/fixtures/contract/v3-patterns.input.json';
        $before = (string) file_get_contents($path);
        $v3 = json_decode($before, true);
        $v4 = json_decode((string) json_encode(Contract::migrate($v3)), true);
        $this->assertSame(4, $v4['version']);
        foreach ($v4['scenes']['slots'] as $scene) {
            $this->assertArrayHasKey('crash', $scene, 'stated on every scene, not left to a default');
            $this->assertFalse($scene['crash'], 'a migrated scene never crashes until the user says so');
        }
        // Everything else is exactly what the v3 reader read: nothing that plays changes.
        $strip = static function (array $p): array {
            unset($p['version']);
            foreach ($p['scenes']['slots'] as $i => $scene) {
                unset($p['scenes']['slots'][$i]['crash']);
            }

            return $p;
        };
        $expectedV3 = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/contract/v3-patterns.expected.json'), true);
        $this->assertEquals($strip($expectedV3), $strip($v4));
        $this->assertSame($before, (string) file_get_contents($path), 'reading never rewrites the original');
    }

    public function test_a_crash_round_trips_on_the_scene_it_was_set_on(): void
    {
        $doc = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/contract/v4-crash.input.json'), true);
        $once = json_decode((string) json_encode(Contract::migrate($doc)), true);
        $twice = json_decode((string) json_encode(Contract::migrate($once)), true);
        $this->assertSame($once, $twice, 'reading what was written gives it back unchanged');
        $this->assertSame(
            ['full' => false, 'sparse' => false, 'build' => false, 'drop' => true],
            array_column($once['scenes']['slots'], 'crash', 'slot'),
        );
    }

    public function test_a_fresh_project_and_a_reset_scene_have_no_crash(): void
    {
        $fresh = Contract::fromTrack(Library::findOrFail('warehouse'));
        $this->assertSame(4, $fresh['version']);
        foreach ($fresh['scenes']['slots'] as $scene) {
            $this->assertFalse($scene['crash']);
        }
    }

    public function test_an_unknown_future_version_is_refused_not_half_read(): void
    {
        $doc = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/contract/v4-crash.input.json'), true);
        $doc['version'] = 5;
        try {
            Contract::migrate($doc);
            $this->fail('A version 5 project was read');
        } catch (\InvalidArgumentException $e) {
            $this->assertSame('Project version 5 is newer than this app understands (4).', $e->getMessage());
        }
    }

    public function test_a_version_3_document_round_trips_exactly(): void
    {
        $v3 = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/contract/v3-patterns.input.json'), true);
        $once = json_decode((string) json_encode(Contract::migrate($v3)), true);
        $twice = json_decode((string) json_encode(Contract::migrate($once)), true);
        $this->assertSame($once, $twice, 'reading what was written gives it back unchanged');
        $this->assertSame([], $once['patterns']['kick']['events'], 'an explicitly empty lane stays empty, not factory');
        $this->assertSame([33, 45], $once['patterns']['bass']['events'][0]['notes'], 'a chord keeps every pitch');
        $this->assertSame(42, $once['patterns']['hat']['origin']['seed'], 'a variation keeps its seed');
        $this->assertSame(['bass'], $once['locks']['lanes']);
        $this->assertSame(['factory' => true], $once['scenes']['slots'][0]['patterns']['kick']);
    }

    public function test_the_factory_pattern_is_the_track_as_written(): void
    {
        $track = Library::findOrFail('warehouse')->arrange();
        $kick = Patterns::factory($track, 'kick');
        $this->assertSame('factory-kick', $kick['id']);
        $hits = array_keys(array_filter($track->kick, static fn ($v) => $v > 0));
        $this->assertSame($hits, array_column($kick['events'], 'step'));
        $this->assertSame('k0', $kick['events'][0]['id']);
        $bass = Patterns::factory($track, 'bass');
        foreach ($bass['events'] as $e) {
            $this->assertNotNull($track->bass[$e['step']]);
            $this->assertLessThanOrEqual(256, $e['step'] + $e['len']);
        }
        $this->assertSame($bass, Patterns::readPattern($bass, 'bass', 'patterns'), 'the factory reads back as a valid pattern');
    }
}
