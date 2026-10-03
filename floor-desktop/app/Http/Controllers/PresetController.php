<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\Music\Library;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;

/**
 * Saved mixes: a track plus the fader, mute and solo state the user dialled in.
 *
 * Presets are small JSON documents on the local disk. This is a desktop app, so
 * "the cloud" is the user's own machine — which means there is no account system
 * and no database. A preset file is the whole feature.
 */
class PresetController
{
    /** Where preset files live. */
    private function disk(): string
    {
        return config('floor.preset_disk');
    }

    /**
     * List saved presets, newest first, with the track they belong to.
     */
    public function index(): JsonResponse
    {
        $presets = [];

        foreach (Storage::disk($this->disk())->files('presets') as $path) {
            $preset = $this->read($path);

            if ($preset !== null) {
                $presets[] = $preset;
            }
        }

        usort(
            $presets,
            static fn (array $a, array $b): int => strcmp((string) $b['updatedAt'], (string) $a['updatedAt']),
        );

        return response()->json(['presets' => $presets]);
    }

    /**
     * Save a preset, or overwrite it when the id already exists.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'id' => [
                'sometimes',
                'string',
                'alpha_dash',
                'max:64',
            ],
            'name' => ['required', 'string', 'max:80'],
            'trackId' => ['required', 'string', Rule::in(array_keys(Library::all()))],
            'bpm' => ['required', 'numeric', 'between:40,200'],
            'swing' => ['required', 'numeric', 'between:0,1'],
            // `sometimes` rather than `required`: a preset may legitimately carry an
            // empty mute map, and Laravel's `required` rejects an empty array. The
            // missing stems are filled in with their defaults below.
            'mix' => ['sometimes', 'array'],
            'muted' => ['sometimes', 'array'],
            'solo' => ['sometimes', 'array'],
        ]);

        // Normalise to a complete, stem-keyed set whatever the client sent, so the
        // stored document always has the same shape and the engine never has to
        // guess at a missing fader.
        $mix = [];
        $muted = [];
        $solo = [];
        foreach (Library::STEMS as $stem) {
            $mix[$stem] = max(0.0, min(1.0, (float) ($validated['mix'][$stem] ?? 0.8)));
            $muted[$stem] = (bool) ($validated['muted'][$stem] ?? false);
            $solo[$stem] = (bool) ($validated['solo'][$stem] ?? false);
        }

        $id = $validated['id'] ?? $this->slug((string) $validated['name']);

        $preset = [
            'id' => $id,
            'name' => $validated['name'],
            'trackId' => $validated['trackId'],
            'bpm' => (float) $validated['bpm'],
            'swing' => (float) $validated['swing'],
            'mix' => $mix,
            'muted' => $muted,
            'solo' => $solo,
            'updatedAt' => gmdate('c'),
        ];

        Storage::disk($this->disk())->put("presets/{$id}.json", $this->encode($preset));

        return response()->json($preset, 201);
    }

    public function show(string $id): JsonResponse
    {
        $preset = $this->read("presets/{$id}.json");

        if ($preset === null) {
            return response()->json(['message' => "Unknown preset: {$id}"], 404);
        }

        return response()->json($preset);
    }

    /**
     * Delete a preset. Only ever removes one named file.
     */
    public function destroy(string $id): JsonResponse
    {
        if (! preg_match('/^[a-z0-9_-]+$/', $id)) {
            return response()->json(['message' => 'Invalid preset id'], 422);
        }

        $disk = Storage::disk($this->disk());

        if (! $disk->exists("presets/{$id}.json")) {
            return response()->json(['message' => "Unknown preset: {$id}"], 404);
        }

        $disk->delete("presets/{$id}.json");

        return response()->json(null, 204);
    }

    /**
     * @return array<string, mixed>|null
     */
    private function read(string $path): ?array
    {
        $disk = Storage::disk($this->disk());

        if (! $disk->exists($path)) {
            return null;
        }

        $decoded = json_decode((string) $disk->get($path), true);

        return is_array($decoded) ? $decoded : null;
    }

    /**
     * @param  array<string, mixed>  $preset
     */
    private function encode(array $preset): string
    {
        return json_encode($preset, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    }

    private function slug(string $name): string
    {
        $slug = strtolower((string) preg_replace('/[^A-Za-z0-9]+/', '-', trim($name)));
        $slug = trim($slug, '-');

        if ($slug === '') {
            $slug = 'preset';
        }

        // Avoid clobbering an unrelated preset when two names collide.
        $disk = Storage::disk($this->disk());
        $candidate = $slug;
        $n = 2;
        while ($disk->exists("presets/{$candidate}.json")) {
            $candidate = "{$slug}-{$n}";
            $n++;
        }

        return $candidate;
    }
}