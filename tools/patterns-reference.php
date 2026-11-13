<?php

declare(strict_types=1);

/**
 * Print every track's factory patterns, and the source hash of every lane over every
 * four-bar part, as JSON. `tools/check-contract.mjs` compares this with what the UI
 * builds from the exported library, so the two factories and the two hashes (used to
 * match a static variation to its source) cannot drift apart.
 *
 * Usage: php tools/patterns-reference.php
 */

use App\Support\Music\Library;
use App\Support\Project\Patterns;

require __DIR__.'/autoload-app.php';

$out = [];
foreach (Library::all() as $id => $track) {
    $arranged = $track->arrange();
    foreach (Patterns::laneIds() as $lane) {
        $pattern = Patterns::factory($arranged, $lane);
        $hashes = [];
        for ($part = 0; $part < 4; $part++) {
            $hashes[] = Patterns::sourceHash($pattern, $part * 64, $part * 64 + 63);
        }
        $out[$id][$lane] = ['pattern' => $pattern, 'hashes' => $hashes];
    }
}

echo json_encode($out, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), "\n";
