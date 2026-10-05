<?php

declare(strict_types=1);

/**
 * Export the track library as static JSON.
 *
 * The app has two deployment shapes, and only one of them needs PHP at runtime:
 *
 * 1. **Desktop / self-hosted** — Laravel serves `/api/tracks`, so the library and the
 *    song form are computed live and presets can be written to disk.
 * 2. **Static** — the frontend is plain files on any CDN or static host, with no PHP
 *    in the request path. This script produces what it needs.
 *
 * Both shapes read the *same* `App\Support\Music\Library`, so the two can never
 * disagree about what a track contains: the static export is generated from the PHP
 * source rather than maintained alongside it. `pnpm run build:static` runs this on
 * every build.
 *
 * Usage: php tools/export-library.php [outputDir]
 */

use App\Support\Music\Library;

require __DIR__.'/../app/Support/Music/Pitch.php';
require __DIR__.'/../app/Support/Music/NoteEvent.php';
require __DIR__.'/../app/Support/Music/Phrase.php';
require __DIR__.'/../app/Support/Music/Track.php';
require __DIR__.'/../app/Support/Music/ArrangedTrack.php';
require __DIR__.'/../app/Support/Music/Arranger.php';
require __DIR__.'/../app/Support/Music/Library.php';

$outDir = $argv[1] ?? __DIR__.'/../public/library';

if (! is_dir($outDir) && ! mkdir($outDir, 0o755, true) && ! is_dir($outDir)) {
    fwrite(STDERR, "could not create {$outDir}\n");

    exit(1);
}

/**
 * Put a fader map into canonical stem order.
 *
 * Several tracks build their mix with PHP's `+` union, which keeps the left operand's
 * keys first, so the JSON key order drifts from the original TypeScript even though
 * every value matches. JSON object order is semantically irrelevant and the engine
 * looks faders up by name, but emitting a stable order keeps the export diffable and
 * lets the parity check be a byte comparison.
 *
 * @param  array<string, float>  $mix
 * @return array<string, float>
 */
$canonicalMix = static function (array $mix): array {
    $ordered = [];
    foreach (Library::STEMS as $stem) {
        $ordered[$stem] = $mix[$stem] ?? 0.8;
    }

    return $ordered;
};

$write = static function (string $path, array $payload): void {
    // No JSON_PRESERVE_ZERO_FRACTION: it would emit `1.0` where the reference emits
    // `1`, which is numerically identical but would turn the parity check against the
    // original TypeScript into a text comparison instead of a value one.
    $json = json_encode(
        $payload,
        JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES,
    );
    file_put_contents($path, $json."\n");
};

/** The stem metadata and library index, matching GET /api/tracks. */
$index = [
    'stems' => [
        ['id' => 'kick', 'name' => 'Kick', 'hint' => 'The pulse', 'keys' => '1'],
        ['id' => 'clap', 'name' => 'Clap', 'hint' => 'Backbeat', 'keys' => '2'],
        ['id' => 'hats', 'name' => 'Hats', 'hint' => 'The top', 'keys' => '3'],
        ['id' => 'bass', 'name' => 'Bass', 'hint' => 'Low end', 'keys' => '4'],
        ['id' => 'stab', 'name' => 'Stab', 'hint' => 'Chords', 'keys' => '5'],
        ['id' => 'lead', 'name' => 'Lead', 'hint' => 'The hook', 'keys' => '6'],
        ['id' => 'pad', 'name' => 'Pad', 'hint' => 'The bed', 'keys' => '7'],
        ['id' => 'arp', 'name' => 'Arp', 'hint' => 'Glitter', 'keys' => '8'],
    ],
    'drums' => Library::DRUMS,
    'music' => Library::MUSIC,
    'tracks' => [],
    'parts' => Library::PARTS,
];

foreach (Library::all() as $track) {
    $index['tracks'][] = [
        'id' => $track->id,
        'name' => $track->name,
        'detail' => $track->detail,
        'kind' => $track->kind,
        'section' => $track->section,
        'style' => $track->style,
        'bpm' => $track->bpm,
        'swing' => $track->swing,
        'mix' => $canonicalMix($track->mix),
    ];
}

$write("{$outDir}/index.json", $index);

$written = 0;
foreach (Library::all() as $track) {
    $arranged = $track->arrange();

    $activity = [];
    for ($bar = 0; $bar < 16; $bar++) {
        $row = [];
        foreach (Library::STEMS as $stem) {
            $row[$stem] = $arranged->barActivity($stem, $bar);
        }
        $activity[$bar] = $row;
    }

    $arrangedJson = $arranged->jsonSerialize();
    $arrangedJson['mix'] = $canonicalMix($arrangedJson['mix']);

    $write("{$outDir}/{$track->id}.json", [
        'track' => $arrangedJson,
        'activity' => $activity,
    ]);
    $written++;
}

printf(
    "exported %d tracks to %s%s",
    $written,
    realpath($outDir) ?: $outDir,
    PHP_EOL,
);