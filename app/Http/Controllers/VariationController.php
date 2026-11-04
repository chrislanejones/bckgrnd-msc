<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\Project\Patterns;
use App\Support\Project\Variation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;

/**
 * Variations: one candidate for part of one lane (`App\Support\Project\Variation`).
 *
 * The request carries the lane as the user has it now, so the variation is of what
 * they hear, not of the track as written. The source and the locks are read with the
 * same strict readers a project uses; anything malformed is refused whole (422).
 * The answer is a candidate or `unavailable` with the reason, never a substitute.
 */
class VariationController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $body = $request->json()->all();
        $lane = is_string($body['lane'] ?? null) ? $body['lane'] : '';
        if (! in_array($lane, Patterns::laneIds(), true)) {
            return response()->json(['error' => 'Unknown lane.'], 422);
        }
        foreach (['from', 'to', 'seed'] as $key) {
            if (! is_int($body[$key] ?? null)) {
                return response()->json(['error' => "{$key} must be a whole number."], 422);
            }
        }
        $seed = (int) $body['seed'];
        if ($seed < 1 || $seed > 2_147_483_647) {
            return response()->json(['error' => 'seed must be between 1 and 2147483647.'], 422);
        }
        $strength = is_string($body['strength'] ?? null) ? $body['strength'] : '';
        if (! isset(Variation::STRENGTHS[$strength])) {
            return response()->json(['error' => 'strength must be subtle, moderate or adventurous.'], 422);
        }
        try {
            $source = Patterns::readPattern($body['source'] ?? null, $lane, 'source');
            $locks = Patterns::readLocks($body['locks'] ?? null);
            $context = Patterns::readPatterns($body['context'] ?? null, 'context');
        } catch (\InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }

        return response()->json(Variation::generate(
            $source,
            (int) $body['from'],
            (int) $body['to'],
            $strength,
            $seed,
            $locks,
            $context,
        ));
    }
}
