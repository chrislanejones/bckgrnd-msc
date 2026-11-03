<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\Music\Library;
use App\Support\Project\Contract;
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
        $this->assertSame((float) $track->mix['bass'], $project['stems']['bass']['volume']);
        $this->assertArrayNotHasKey('performance.loopBars', $project['params'], 'performance gestures are not saved');
        $this->assertEquals($project, Contract::migrate(json_decode(json_encode($project), true)), 'a fresh project round-trips');
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
}
