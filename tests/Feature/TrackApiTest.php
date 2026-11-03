<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Support\Music\Library;
use Tests\TestCase;

/**
 * The API the app reads on boot, and the static export the Netlify build reads
 * instead. The two must describe the same instrument.
 */
final class TrackApiTest extends TestCase
{
    public function test_the_index_lists_stems_groups_and_tracks(): void
    {
        $response = $this->getJson('/api/tracks')->assertOk();

        $this->assertSame(Library::STEMS, array_column($response->json('stems'), 'id'));
        $this->assertSame(['1', '2', '3', '4', '5', '6', '7', '8'], array_column($response->json('stems'), 'keys'));
        $this->assertSame(Library::DRUMS, $response->json('drums'));
        $this->assertSame(Library::MUSIC, $response->json('music'));
        $this->assertCount(18, $response->json('tracks'));
        $this->assertSame('warehouse', $response->json('tracks.0.id'));
    }

    public function test_a_track_arrives_arranged_with_its_activity(): void
    {
        $response = $this->getJson('/api/tracks/warehouse')->assertOk();

        $this->assertSame('warehouse', $response->json('track.id'));
        $this->assertCount(256, $response->json('track.kick'));
        $this->assertCount(256, $response->json('track.bass'));
        $this->assertCount(16, $response->json('activity'));
        $this->assertCount(16, $response->json('activity.0.kick'));
    }

    public function test_an_unknown_track_is_a_json_404(): void
    {
        $this->getJson('/api/tracks/nope')
            ->assertNotFound()
            ->assertJson(['message' => 'Unknown track: nope']);
    }

    public function test_health_reports_the_library(): void
    {
        $this->getJson('/api/health')->assertOk()->assertJson(['ok' => true, 'tracks' => 18]);
    }

    /**
     * The static export in public/library is committed and served by Netlify. If the
     * PHP library changes and nobody re-runs the export, the live site plays the old
     * tracks without any error, so this compares the two byte for byte (as JSON).
     */
    public function test_the_static_export_matches_the_live_api(): void
    {
        $dir = dirname(__DIR__, 2).'/public/library';
        $this->assertFileExists("{$dir}/index.json", 'run php tools/export-library.php public/library');

        $index = json_decode((string) file_get_contents("{$dir}/index.json"), true);
        $this->assertEquals($this->getJson('/api/tracks')->json(), $index, 'public/library/index.json is stale');

        foreach (Library::all() as $id => $track) {
            $exported = json_decode((string) file_get_contents("{$dir}/{$id}.json"), true);
            $this->assertEquals(
                $this->getJson("/api/tracks/{$id}")->json(),
                $exported,
                "public/library/{$id}.json is stale; run php tools/export-library.php public/library",
            );
        }
    }
}
