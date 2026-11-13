<?php

declare(strict_types=1);

/**
 * Export the static variation catalog: what `POST /api/variations` would answer for
 * each track as written, for the static build, which has no PHP to ask.
 *
 * One file per track, `public/library/variations/<id>.json`, holding every editable
 * lane × song part (bars 1-4, 5-8, 9-12, 13-16) × strength × seeds 1-3, each keyed by
 * the source's content hash (`Patterns::sourceHash`) over its range. The browser uses
 * an entry only when the phrase it has now hashes the same: an edited phrase has no
 * entry, and the editor says the variation is unavailable rather than substitute one
 * made for different notes. Locks are applied by refusing an entry that would change
 * a locked event (the catalog cannot regenerate around them).
 *
 * Usage: php tools/export-variations.php [outputDir]
 */

use App\Support\Music\Library;
use App\Support\Project\Patterns;
use App\Support\Project\Variation;

require __DIR__.'/autoload-app.php';

$outDir = $argv[1] ?? __DIR__.'/../public/library/variations';
if (! is_dir($outDir) && ! mkdir($outDir, 0o755, true) && ! is_dir($outDir)) {
    fwrite(STDERR, "could not create {$outDir}\n");
    exit(1);
}

const SEEDS = [1, 2, 3];
$lanes = array_values(array_filter(
    Patterns::registry()['lanes'],
    fn (array $l): bool => (bool) $l['editable'],
));
$noLocks = ['lanes' => [], 'events' => []];
$count = 0;

foreach (Library::all() as $track) {
    $arranged = $track->arrange();
    $context = [];
    foreach (Patterns::laneIds() as $id) {
        $context[$id] = Patterns::factory($arranged, $id);
    }
    $entries = [];
    foreach ($lanes as $lane) {
        $source = $context[$lane['id']];
        for ($part = 0; $part < 4; $part++) {
            $from = $part * 64;
            $to = $from + 63;
            $hash = Patterns::sourceHash($source, $from, $to);
            foreach (array_keys(Variation::STRENGTHS) as $strength) {
                foreach (SEEDS as $seed) {
                    $res = Variation::generate($source, $from, $to, $strength, $seed, $noLocks, $context);
                    if ($res['status'] !== 'ok') {
                        continue;
                    }
                    $inRange = array_values(array_filter(
                        $res['candidate']['events'],
                        fn (array $e): bool => $e['step'] >= $from && $e['step'] <= $to,
                    ));
                    $entries[] = [
                        'lane' => $lane['id'],
                        'from' => $from,
                        'to' => $to,
                        'strength' => $strength,
                        'seed' => $seed,
                        'sourceHash' => $hash,
                        'mode' => $res['mode'],
                        'reason' => $res['reason'],
                        'preserved' => $res['preserved'],
                        'events' => $inRange,
                    ];
                }
            }
        }
    }
    $count += count($entries);
    file_put_contents(
        "{$outDir}/{$track->id}.json",
        json_encode(['generator' => Variation::GENERATOR, 'seeds' => SEEDS, 'entries' => $entries], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n",
    );
}

fwrite(STDOUT, "[variations] {$count} entries for ".count(Library::all())." tracks in {$outDir}\n");
