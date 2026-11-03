<?php

declare(strict_types=1);

namespace App\Support\Project;

use App\Support\Music\Library;
use App\Support\Music\Track;

/**
 * The project and parameter contract, as PHP reads it.
 *
 * `contracts/parameters.json` is the single list of parameters, shared with the UI
 * (`frontend/lib/contract.ts`) and the MCP companion. This class never restates a
 * range or a default; it reads them from that file, so the three readers cannot
 * drift apart without a test noticing.
 *
 * A project is saved musical data only. Telemetry is never part of one: see
 * `contracts/README.md`.
 */
final class Contract
{
    public const FORMAT = 'bckgrnd-msc/project';

    public const VERSION = 1;

    /** @var array<string, mixed>|null */
    private static ?array $registry = null;

    /**
     * The decoded parameter registry.
     *
     * @return array{contract: string, version: int, stems: list<string>, parameters: list<array<string, mixed>>, stemParameters: list<array<string, mixed>>}
     */
    public static function registry(): array
    {
        if (self::$registry === null) {
            $path = dirname(__DIR__, 3).'/contracts/parameters.json';
            $decoded = json_decode((string) file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
            self::$registry = $decoded;
        }

        /** @var array{contract: string, version: int, stems: list<string>, parameters: list<array<string, mixed>>, stemParameters: list<array<string, mixed>>} */
        return self::$registry;
    }

    /**
     * One parameter by id, or null.
     *
     * @return array<string, mixed>|null
     */
    public static function parameter(string $id): ?array
    {
        foreach (self::registry()['parameters'] as $parameter) {
            if ($parameter['id'] === $id) {
                return $parameter;
            }
        }

        return null;
    }

    /**
     * The parameters a project saves.
     *
     * @return list<array<string, mixed>>
     */
    public static function projectParameters(): array
    {
        return array_values(array_filter(
            self::registry()['parameters'],
            static fn (array $p): bool => $p['scope'] === 'project',
        ));
    }

    /**
     * A fresh project for a track: every parameter at its default.
     *
     * @return array<string, mixed>
     */
    public static function fromTrack(Track $track, string $name = ''): array
    {
        $params = [];
        foreach (self::projectParameters() as $parameter) {
            $params[$parameter['id']] = self::defaultFor($parameter, $track);
        }

        $stems = [];
        foreach (Library::STEMS as $stem) {
            $stems[$stem] = [
                'volume' => (float) ($track->mix[$stem] ?? 0.8),
                'muted' => false,
                'solo' => false,
            ];
        }

        return [
            'format' => self::FORMAT,
            'version' => self::VERSION,
            'name' => $name !== '' ? $name : $track->name,
            'trackId' => $track->id,
            'params' => $params,
            'stems' => $stems,
            'patterns' => new \stdClass,
        ];
    }

    /**
     * Read any supported document into a complete, clamped version 1 project.
     *
     * Accepts a version 1 project or a legacy preset (the shape `PresetController`
     * writes, which has no `format`). Anything else is refused: an unknown format, or
     * a version newer than this reader, would otherwise be half-understood and saved
     * back with data missing.
     *
     * @param  array<string, mixed>  $document
     * @return array<string, mixed>
     */
    public static function migrate(array $document): array
    {
        if (! array_key_exists('format', $document)) {
            $document = self::fromLegacyPreset($document);
        }

        if ($document['format'] !== self::FORMAT) {
            throw new \InvalidArgumentException('Not a bckgrnd-msc project: format is '.json_encode($document['format']));
        }
        $version = $document['version'] ?? null;
        if (! is_int($version) || $version < 1) {
            throw new \InvalidArgumentException('Project version is missing or invalid.');
        }
        if ($version > self::VERSION) {
            throw new \InvalidArgumentException("Project version {$version} is newer than this app understands (".self::VERSION.').');
        }

        return self::normalize($document);
    }

    /**
     * Fill defaults and clamp every value into the contract's ranges.
     *
     * @param  array<string, mixed>  $project
     * @return array<string, mixed>
     */
    public static function normalize(array $project): array
    {
        $trackId = (string) ($project['trackId'] ?? '');
        $track = Library::find($trackId);
        if ($track === null) {
            throw new \InvalidArgumentException("Unknown track: {$trackId}");
        }

        $fresh = self::fromTrack($track, (string) ($project['name'] ?? ''));

        $params = [];
        $given = is_array($project['params'] ?? null) ? $project['params'] : [];
        foreach (self::projectParameters() as $parameter) {
            $id = $parameter['id'];
            $value = $given[$id] ?? $fresh['params'][$id];
            $params[$id] = self::clamp($parameter, $value);
        }

        $stems = [];
        $givenStems = is_array($project['stems'] ?? null) ? $project['stems'] : [];
        foreach (Library::STEMS as $stem) {
            $given = is_array($givenStems[$stem] ?? null) ? $givenStems[$stem] : [];
            $stems[$stem] = [
                'volume' => max(0.0, min(1.0, (float) ($given['volume'] ?? $fresh['stems'][$stem]['volume']))),
                'muted' => (bool) ($given['muted'] ?? false),
                'solo' => (bool) ($given['solo'] ?? false),
            ];
        }

        $out = [
            'format' => self::FORMAT,
            'version' => self::VERSION,
        ];
        if (isset($project['id']) && is_string($project['id'])) {
            $out['id'] = $project['id'];
        }
        $out['name'] = $fresh['name'];
        foreach (['createdAt', 'updatedAt'] as $stamp) {
            if (isset($project[$stamp]) && is_string($project[$stamp])) {
                $out[$stamp] = $project[$stamp];
            }
        }
        $out['trackId'] = $track->id;
        $out['params'] = $params;
        $out['stems'] = $stems;
        $out['patterns'] = new \stdClass;

        return $out;
    }

    /**
     * A legacy preset (no `format`) as a version 1 document. Effects were never
     * stored in presets, so they are left out and take their defaults.
     *
     * @param  array<string, mixed>  $preset
     * @return array<string, mixed>
     */
    public static function fromLegacyPreset(array $preset): array
    {
        $stems = [];
        foreach (Library::STEMS as $stem) {
            $entry = [];
            if (isset($preset['mix'][$stem])) {
                $entry['volume'] = (float) $preset['mix'][$stem];
            }
            if (isset($preset['muted'][$stem])) {
                $entry['muted'] = (bool) $preset['muted'][$stem];
            }
            if (isset($preset['solo'][$stem])) {
                $entry['solo'] = (bool) $preset['solo'][$stem];
            }
            $stems[$stem] = $entry;
        }

        $params = [];
        if (isset($preset['bpm'])) {
            $params['transport.bpm'] = (float) $preset['bpm'];
        }
        if (isset($preset['swing'])) {
            $params['transport.swing'] = (float) $preset['swing'];
        }

        $out = [
            'format' => self::FORMAT,
            'version' => self::VERSION,
            'name' => (string) ($preset['name'] ?? ''),
            'trackId' => (string) ($preset['trackId'] ?? ''),
            'params' => $params,
            'stems' => $stems,
            'patterns' => [],
        ];
        if (isset($preset['id'])) {
            $out['id'] = (string) $preset['id'];
        }
        if (isset($preset['updatedAt'])) {
            $out['updatedAt'] = (string) $preset['updatedAt'];
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $parameter
     */
    private static function defaultFor(array $parameter, Track $track): float
    {
        if ($parameter['default'] !== 'track') {
            return (float) $parameter['default'];
        }

        return match ($parameter['id']) {
            'transport.bpm' => $track->bpm,
            'transport.swing' => $track->swing,
            default => throw new \LogicException("No track default for {$parameter['id']}"),
        };
    }

    /**
     * @param  array<string, mixed>  $parameter
     */
    private static function clamp(array $parameter, mixed $value): float
    {
        $number = is_numeric($value) ? (float) $value : (float) $parameter['default'];

        if ($parameter['kind'] === 'enum') {
            // Snap to the nearest listed option: an enum outside its list is a value
            // the engine has no label for.
            $best = null;
            foreach ($parameter['options'] as $option) {
                $candidate = (float) $option['value'];
                if ($best === null || abs($candidate - $number) < abs($best - $number)) {
                    $best = $candidate;
                }
            }

            return (float) $best;
        }

        return max((float) $parameter['min'], min((float) $parameter['max'], $number));
    }
}
