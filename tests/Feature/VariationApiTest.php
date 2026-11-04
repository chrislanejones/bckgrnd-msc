<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Support\Music\Library;
use App\Support\Project\Patterns;
use Tests\TestCase;

/** POST /api/variations: the candidate PHP writes for the lane the user has now. */
final class VariationApiTest extends TestCase
{
    private function body(array $overrides = []): array
    {
        $track = Library::findOrFail('warehouse')->arrange();

        return array_merge([
            'lane' => 'hat',
            'from' => 128,
            'to' => 191,
            'strength' => 'moderate',
            'seed' => 9,
            'source' => Patterns::factory($track, 'hat'),
            'locks' => ['lanes' => [], 'events' => (object) []],
        ], $overrides);
    }

    public function test_a_variation_comes_back_seeded(): void
    {
        $a = $this->postJson('/api/variations', $this->body())->assertOk();
        $b = $this->postJson('/api/variations', $this->body())->assertOk();
        $this->assertSame('ok', $a->json('status'));
        $this->assertSame($a->json('candidate'), $b->json('candidate'));
        $this->assertSame('variation', $a->json('candidate.origin.kind'));
    }

    public function test_a_malformed_source_is_refused_whole(): void
    {
        $body = $this->body();
        $body['source']['events'][] = ['id' => 'x1', 'step' => 999, 'vel' => 0.5];
        $this->postJson('/api/variations', $body)
            ->assertStatus(422)
            ->assertJsonPath('error', fn ($e) => str_starts_with($e, 'Patterns are malformed: source hat'));
    }

    public function test_a_locked_lane_is_unavailable(): void
    {
        $this->postJson('/api/variations', $this->body(['locks' => ['lanes' => ['hat'], 'events' => (object) []]]))
            ->assertOk()
            ->assertJsonPath('status', 'unavailable');
    }

    public function test_bad_inputs_are_422(): void
    {
        $this->postJson('/api/variations', $this->body(['lane' => 'cowbell']))->assertStatus(422);
        $this->postJson('/api/variations', $this->body(['strength' => 'wild']))->assertStatus(422);
        $this->postJson('/api/variations', $this->body(['seed' => 0]))->assertStatus(422);
    }
}
