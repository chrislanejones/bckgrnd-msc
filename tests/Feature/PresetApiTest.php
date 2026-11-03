<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Support\Project\Contract;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Saved mixes on disk. No UI uses them yet; they are covered because they are the
 * format the project contract has to migrate forward without loss.
 */
final class PresetApiTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
    }

    public function test_a_preset_is_saved_normalized_and_listed(): void
    {
        $saved = $this->postJson('/api/presets', [
            'name' => 'No Drums',
            'trackId' => 'warehouse',
            'bpm' => 124,
            'swing' => 0.2,
            'mix' => ['bass' => 1.4],
            'muted' => ['kick' => true],
        ])->assertCreated();

        $this->assertSame('no-drums', $saved->json('id'));
        $this->assertSame(1, $saved->json('mix.bass'), 'out-of-range levels are clamped');
        $this->assertSame(0.8, $saved->json('mix.kick'), 'missing stems take a default');
        $this->assertTrue($saved->json('muted.kick'));
        $this->assertFalse($saved->json('solo.arp'));

        $this->getJson('/api/presets')->assertOk()->assertJsonPath('presets.0.id', 'no-drums');
        $this->getJson('/api/presets/no-drums')->assertOk()->assertJsonPath('trackId', 'warehouse');
    }

    public function test_a_name_collision_gets_a_new_id(): void
    {
        $body = ['name' => 'Mine', 'trackId' => 'rain', 'bpm' => 84, 'swing' => 0.4];
        $this->postJson('/api/presets', $body)->assertCreated()->assertJsonPath('id', 'mine');
        $this->postJson('/api/presets', $body)->assertCreated()->assertJsonPath('id', 'mine-2');
    }

    public function test_an_unknown_track_or_tempo_out_of_range_is_refused(): void
    {
        $this->postJson('/api/presets', ['name' => 'x', 'trackId' => 'nope', 'bpm' => 120, 'swing' => 0])
            ->assertUnprocessable()->assertJsonValidationErrors('trackId');
        $this->postJson('/api/presets', ['name' => 'x', 'trackId' => 'rain', 'bpm' => 400, 'swing' => 0])
            ->assertUnprocessable()->assertJsonValidationErrors('bpm');
    }

    public function test_delete_only_touches_one_named_file(): void
    {
        $this->postJson('/api/presets', ['name' => 'Gone', 'trackId' => 'rain', 'bpm' => 84, 'swing' => 0.4]);
        $this->deleteJson('/api/presets/gone')->assertNoContent();
        $this->deleteJson('/api/presets/gone')->assertNotFound();
        $this->deleteJson('/api/presets/..%2Fescape')->assertStatus(404);
    }

    public function test_a_saved_preset_migrates_to_a_v1_project_without_loss(): void
    {
        $preset = $this->postJson('/api/presets', [
            'name' => 'Kept',
            'trackId' => 'acid',
            'bpm' => 131,
            'swing' => 0.1,
            'mix' => ['lead' => 0.25],
            'solo' => ['bass' => true],
        ])->json();

        $project = Contract::migrate($preset);

        $this->assertSame('bckgrnd-msc/project', $project['format']);
        $this->assertSame('kept', $project['id']);
        $this->assertSame(131.0, $project['params']['transport.bpm']);
        $this->assertSame(0.1, $project['params']['transport.swing']);
        $this->assertSame(0.25, $project['stems']['lead']['volume']);
        $this->assertTrue($project['stems']['bass']['solo']);
    }
}
