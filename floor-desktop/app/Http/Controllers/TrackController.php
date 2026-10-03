<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\Music\Library;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;

/**
 * Serves the track library to the desktop app.
 *
 * The engine needs a fully arranged track — 256 steps on nine lanes — and the
 * arrangement is computed here rather than shipped in the browser bundle, so the
 * library is the single source of truth for both playback and the API.
 */
class TrackController extends Controller
{
    /**
     * The library index: id, name and flavour for every track, plus the stem
     * metadata the UI needs. Deliberately cheap, since it is called on boot.
     */
    public function index(): JsonResponse
    {
        $tracks = [];

        foreach (Library::all() as $track) {
            $tracks[] = [
                'id' => $track->id,
                'name' => $track->name,
                'detail' => $track->detail,
                'kind' => $track->kind,
                'bpm' => $track->bpm,
                'swing' => $track->swing,
                'mix' => $track->mix,
                'parts' => Library::PARTS,
            ];
        }

        return response()->json([
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
            'tracks' => $tracks,
        ]);
    }

    /**
     * One arranged track, ready for the engine.
     *
     * `activity` gives the UI's per-bar step rows so it can draw a stem's pattern
     * without shipping all nine lanes to the client.
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $track = Library::find($id);

        if ($track === null) {
            return response()->json(['message' => "Unknown track: {$id}"], 404);
        }

        $arranged = $track->arrange();

        $activity = [];
        for ($bar = 0; $bar < 16; $bar++) {
            $row = [];
            foreach (Library::STEMS as $stem) {
                $row[$stem] = $arranged->barActivity($stem, $bar);
            }
            $activity[$bar] = $row;
        }

        return response()->json([
            'track' => $arranged->jsonSerialize(),
            'activity' => $activity,
        ]);
    }
}