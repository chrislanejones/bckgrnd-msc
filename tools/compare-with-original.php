<?php

declare(strict_types=1);

/**
 * Compare the PHP library against the original TypeScript arrangements.
 *
 * Run as: php tools/compare-with-original.php [path/to/reference.json]
 *
 * The reference file is produced by the Node script that imports the original
 * `music.ts` and dumps every arranged track as JSON. Any lane that differs is a
 * transcription error in the port, so this is the check that the PHP library is
 * genuinely the same instrument rather than merely a plausible one.
 */
use App\Support\Music\Library;

// A minimal PSR-4 autoloader for `App\`, so this check runs without `composer
// install` — useful in CI before dependencies are present.
spl_autoload_register(static function (string $class): void {
    if (! str_starts_with($class, 'App\\')) {
        return;
    }
    $path = __DIR__.'/../app/'.str_replace('\\', '/', substr($class, 4)).'.php';
    if (is_file($path)) {
        require $path;
    }
});

$referencePath = $argv[1] ?? __DIR__.'/reference.json';

if (! is_file($referencePath)) {
    fwrite(STDERR, "reference not found: {$referencePath}\n");
    fwrite(STDERR, "generate it with: node tools/dump-reference.mjs\n");

    exit(2);
}

/** @var array<string, array<string, mixed>> $reference */
$reference = json_decode((string) file_get_contents($referencePath), true, 512, JSON_THROW_ON_ERROR);

$lanes = ['kick', 'clap', 'hat', 'hatOpen', 'bass', 'stab', 'lead', 'pad', 'arp'];
$fields = ['id', 'name', 'kind', 'bpm', 'swing', 'mix'];

/**
 * The groove section of the arrangement, in steps.
 *
 * `Arranger` copies the four-bar groove verbatim into bars 5-8, so comparing that
 * slice proves the *library* is still the same instrument as the original. Comparing
 * the whole arrangement would instead assert that the intro is still as sparse as it
 * was, which is a musical decision we have deliberately changed — see `Arranger`.
 */
const GROOVE_START = 4 * 16;
const GROOVE_END = 8 * 16;

$problems = [];
$checked = 0;
$divergences = [];

foreach ($reference as $id => $expected) {
    $track = Library::find((string) $id);

    if ($track === null) {
        $problems[] = "{$id}: missing from the PHP library";

        continue;
    }

    $actual = $track->arrange()->jsonSerialize();

    foreach ($fields as $field) {
        $checked++;
        $want = $expected[$field] ?? null;
        $got = $actual[$field] ?? null;
        if ($want != $got) {
            $problems[] = sprintf(
                '%s.%s: expected %s, got %s',
                $id,
                $field,
                json_encode($want),
                json_encode($got),
            );
        }
    }

    foreach ($lanes as $lane) {
        // The groove must match exactly.
        $checked++;
        $want = array_slice($expected[$lane] ?? [], GROOVE_START, GROOVE_END - GROOVE_START);
        $got = array_slice($actual[$lane] ?? [], GROOVE_START, GROOVE_END - GROOVE_START);

        if (json_encode($want) !== json_encode($got)) {
            $problems[] = "{$id}.{$lane}: the groove section no longer matches the original";
        }

        // Everything else is arrangement, which we own. Recorded, not enforced.
        foreach ([['intro', 0], ['break', 2]] as [$section, $index]) {
            $from = $index * 4 * 16;
            $to = $from + 4 * 16;
            $referenceSlice = array_slice($expected[$lane] ?? [], $from, $to - $from);
            $actualSlice = array_slice($actual[$lane] ?? [], $from, $to - $from);
            if (json_encode($referenceSlice) !== json_encode($actualSlice)) {
                $divergences[] = "{$id}.{$lane} ({$section})";
            }
        }
    }
}

$extra = array_diff(array_keys(Library::all()), array_keys($reference));
foreach ($extra as $id) {
    $problems[] = "{$id}: present in PHP but not in the reference";
}

if ($problems !== []) {
    fwrite(STDERR, sprintf("%d mismatches out of %d checks:\n", count($problems), $checked));
    foreach ($problems as $problem) {
        fwrite(STDERR, "  {$problem}\n");
    }

    exit(1);
}

printf(
    "OK: %d checks across %d tracks — metadata and groove sections match the original exactly.\n",
    $checked,
    count($reference),
);

if ($divergences !== []) {
    printf(
        "%d intentional arrangement divergences from the original (intro and break are ours): %s\n",
        count($divergences),
        implode(', ', array_slice($divergences, 0, 6)).(count($divergences) > 6 ? ', …' : ''),
    );
}