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

    public const VERSION = 2;

    /** The four scene slots, in order. */
    public const SCENE_SLOTS = ['full', 'sparse', 'build', 'drop'];

    /** @var array<string, mixed>|null */
    private static ?array $registry = null;

    /** @var array<string, mixed>|null */
    private static ?array $scenes = null;

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
     * The decoded scene contract: slots, the scene parameters (`sceneVector`) and the
     * factory recipes. See docs/NIGHT3_PROTOCOL.md.
     *
     * @return array{contract: string, version: int, slots: list<string>, sceneVector: list<string>, factory: list<array<string, mixed>>}
     */
    public static function scenesContract(): array
    {
        if (self::$scenes === null) {
            $path = dirname(__DIR__, 3).'/contracts/scenes.json';
            self::$scenes = json_decode((string) file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
        }

        /** @var array{contract: string, version: int, slots: list<string>, sceneVector: list<string>, factory: list<array<string, mixed>>} */
        return self::$scenes;
    }

    /**
     * The parameters a scene holds, in engine vector order.
     *
     * @return list<string>
     */
    public static function sceneParameterIds(): array
    {
        return self::scenesContract()['sceneVector'];
    }

    /**
     * One factory scene for a track, built from its recipe relative to the track's
     * own mix: `scale` multiplies the track's level, `cut` mutes the stem, anything
     * not listed keeps the track's level and the registry default.
     *
     * @return array<string, mixed>
     */
    public static function factoryScene(Track $track, string $recipeId, string $slot, int $revision = 1): array
    {
        $recipe = null;
        foreach (self::scenesContract()['factory'] as $candidate) {
            if ($candidate['id'] === $recipeId) {
                $recipe = $candidate;
            }
        }
        if ($recipe === null) {
            throw new \LogicException("No factory scene {$recipeId}");
        }

        $params = [];
        foreach (self::sceneParameterIds() as $id) {
            $parameter = self::parameter($id) ?? throw new \LogicException("No parameter {$id}");
            $params[$id] = (float) ($recipe['params'][$id] ?? $parameter['default']);
        }

        $stems = [];
        $sends = self::stemParameter('send')['defaults'];
        foreach (Library::STEMS as $stem) {
            $rule = $recipe['stems'][$stem] ?? [];
            $level = (float) ($track->mix[$stem] ?? 0.8);
            $stems[$stem] = [
                'volume' => max(0.0, min(1.0, $level * (float) ($rule['scale'] ?? 1))),
                'send' => (float) $sends[$stem],
                'muted' => (bool) ($rule['cut'] ?? false),
                'solo' => false,
            ];
        }

        return [
            'slot' => $slot,
            'name' => (string) $recipe['name'],
            'factory' => $recipeId,
            'revision' => $revision,
            'params' => $params,
            'stems' => $stems,
            'patterns' => new \stdClass,
        ];
    }

    /**
     * The four factory scenes for a track: each slot gets the recipe of the same name.
     *
     * @return array{slots: list<array<string, mixed>>}
     */
    public static function factoryScenes(Track $track): array
    {
        return ['slots' => array_map(
            static fn (string $slot): array => self::factoryScene($track, $slot, $slot),
            self::SCENE_SLOTS,
        )];
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
     * One per-stem parameter by id.
     *
     * @return array<string, mixed>
     */
    public static function stemParameter(string $id): array
    {
        foreach (self::registry()['stemParameters'] as $parameter) {
            if ($parameter['id'] === $id) {
                return $parameter;
            }
        }

        throw new \LogicException("No stem parameter {$id}");
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
        $sends = self::stemParameter('send')['defaults'];
        foreach (Library::STEMS as $stem) {
            $stems[$stem] = [
                'volume' => (float) ($track->mix[$stem] ?? 0.8),
                'send' => (float) $sends[$stem],
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
            'scenes' => self::factoryScenes($track),
        ];
    }

    /**
     * Read any supported document into a complete, clamped version 2 project.
     *
     * Accepts version 2, version 1 (migrated by adding the track's factory scenes and
     * changing nothing else) or a legacy preset (the shape `PresetController` writes,
     * which has no `format`). Anything else is refused: an unknown format, or a
     * version newer than this reader, would otherwise be half-understood and saved
     * back with data missing. A version 2 document whose scenes do not read cleanly
     * is refused whole, so a bad scene can never reach the mix.
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
        if ($version === 1 && array_key_exists('scenes', $document)) {
            throw new \InvalidArgumentException('A version 1 project cannot carry scenes.');
        }
        if ($version >= 2 && ! array_key_exists('scenes', $document)) {
            throw new \InvalidArgumentException('Scenes are missing from a version 2 project.');
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
                'send' => max(0.0, min(1.0, is_numeric($given['send'] ?? null) ? (float) $given['send'] : $fresh['stems'][$stem]['send'])),
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
        // A project without scenes (version 1, or one being built) gets the track's
        // factory scenes. Nothing is applied: the working mix above is what it was.
        $out['scenes'] = array_key_exists('scenes', $project)
            ? self::readScenes($project['scenes'])
            : $fresh['scenes'];

        return $out;
    }

    /**
     * Read version 2 scenes strictly. Every slot must be present, in order, and
     * complete; any unknown key, wrong type, out-of-range value or pattern reference
     * refuses the whole set. Nothing is clamped or filled here: a scene is written
     * complete when it is captured.
     *
     * @return array{slots: list<array<string, mixed>>}
     */
    public static function readScenes(mixed $scenes): array
    {
        $fail = static fn (string $why): never => throw new \InvalidArgumentException("Scenes are malformed: {$why}");

        if (! is_array($scenes) || array_keys($scenes) !== ['slots']) {
            $fail('expected an object with only "slots"');
        }
        $slots = $scenes['slots'];
        if (! is_array($slots) || ! array_is_list($slots) || count($slots) !== count(self::SCENE_SLOTS)) {
            $fail('expected '.count(self::SCENE_SLOTS).' slots');
        }

        $factoryIds = array_column(self::scenesContract()['factory'], 'id');
        $sceneIds = self::sceneParameterIds();
        $keys = ['slot', 'name', 'factory', 'revision', 'params', 'stems', 'patterns'];
        $out = [];
        foreach ($slots as $i => $scene) {
            $slot = self::SCENE_SLOTS[$i];
            if (! is_array($scene)) {
                $fail("slot {$slot} is not an object");
            }
            $extra = array_diff(array_keys($scene), $keys);
            $missing = array_diff($keys, array_keys($scene));
            if ($extra !== [] || $missing !== []) {
                $fail("slot {$slot} has keys ".json_encode(array_values($extra)).' and lacks '.json_encode(array_values($missing)));
            }
            if ($scene['slot'] !== $slot) {
                $fail("slot {$i} should be {$slot}");
            }
            if (! is_string($scene['name']) || $scene['name'] === '' || mb_strlen($scene['name']) > 40) {
                $fail("slot {$slot} needs a name of 1 to 40 characters");
            }
            if (! in_array($scene['factory'], $factoryIds, true)) {
                $fail("slot {$slot} names an unknown factory scene");
            }
            if (! is_int($scene['revision']) || $scene['revision'] < 1) {
                $fail("slot {$slot} needs a whole-number revision of at least 1");
            }
            if (! is_array($scene['patterns']) || $scene['patterns'] !== []) {
                $fail("slot {$slot} refers to patterns, which this version does not support");
            }

            $params = $scene['params'];
            if (! is_array($params) || array_diff(array_keys($params), $sceneIds) !== [] || array_diff($sceneIds, array_keys($params)) !== []) {
                $fail("slot {$slot} must hold exactly the scene parameters");
            }
            $readParams = [];
            foreach ($sceneIds as $id) {
                $value = $params[$id];
                $parameter = self::parameter($id) ?? throw new \LogicException("No parameter {$id}");
                if (! self::inRange($parameter, $value)) {
                    $fail("slot {$slot} has {$id} out of range");
                }
                $readParams[$id] = (float) $value;
            }

            $stems = $scene['stems'];
            if (! is_array($stems) || array_keys($stems) !== Library::STEMS) {
                $fail("slot {$slot} must hold every stem, in order");
            }
            $readStems = [];
            foreach (Library::STEMS as $stem) {
                $entry = $stems[$stem];
                if (! is_array($entry) || array_keys($entry) !== ['volume', 'send', 'muted', 'solo']) {
                    $fail("slot {$slot} stem {$stem} must have volume, send, muted and solo");
                }
                foreach (['volume', 'send'] as $level) {
                    $v = $entry[$level];
                    if (! (is_int($v) || is_float($v)) || ! is_finite((float) $v) || $v < 0 || $v > 1) {
                        $fail("slot {$slot} stem {$stem} {$level} must be a number from 0 to 1");
                    }
                }
                if (! is_bool($entry['muted']) || ! is_bool($entry['solo'])) {
                    $fail("slot {$slot} stem {$stem} muted and solo must be true or false");
                }
                $readStems[$stem] = [
                    'volume' => (float) $entry['volume'],
                    'send' => (float) $entry['send'],
                    'muted' => $entry['muted'],
                    'solo' => $entry['solo'],
                ];
            }

            $out[] = [
                'slot' => $slot,
                'name' => $scene['name'],
                'factory' => $scene['factory'],
                'revision' => $scene['revision'],
                'params' => $readParams,
                'stems' => $readStems,
                'patterns' => new \stdClass,
            ];
        }

        return ['slots' => $out];
    }

    /**
     * Whether a value is one the parameter accepts as written: inside its range, or
     * one of its options for an enum. Used where values are refused, not clamped.
     *
     * @param  array<string, mixed>  $parameter
     */
    private static function inRange(array $parameter, mixed $value): bool
    {
        if (! (is_int($value) || is_float($value)) || ! is_finite((float) $value)) {
            return false;
        }
        if ($parameter['kind'] === 'enum') {
            foreach ($parameter['options'] as $option) {
                if (abs((float) $option['value'] - (float) $value) < 1e-9) {
                    return true;
                }
            }

            return false;
        }

        return (float) $parameter['min'] <= $value && $value <= (float) $parameter['max'];
    }

    /**
     * A legacy preset (no `format`) as a version 1 document, which `migrate()` then
     * carries to the current version. Effects were never
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
            'version' => 1,
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
