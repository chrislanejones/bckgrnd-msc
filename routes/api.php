<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;

/**
 * The track library. Public, because the app ships with its tracks baked in and
 * there is nothing to authenticate against.
 */
Route::get('/tracks', [\App\Http\Controllers\TrackController::class, 'index']);
Route::get('/tracks/{id}', [\App\Http\Controllers\TrackController::class, 'show']);

/**
 * Saved mixes. No account system: this is a desktop app, so a preset file on the
 * user's own disk is the whole model.
 */
Route::get('/presets', [\App\Http\Controllers\PresetController::class, 'index']);
Route::post('/presets', [\App\Http\Controllers\PresetController::class, 'store']);
Route::get('/presets/{id}', [\App\Http\Controllers\PresetController::class, 'show']);
Route::delete('/presets/{id}', [\App\Http\Controllers\PresetController::class, 'destroy']);

/**
 * Health check. Also the quickest way to confirm the NativePHP shell is talking
 * to a booted Laravel app.
 */
Route::get('/health', function (): \Illuminate\Http\JsonResponse {
    return response()->json([
        'ok' => true,
        'engine' => 'bckgrnd-msc-engine (wasm)',
        'tracks' => count(\App\Support\Music\Library::all()),
        'presetDisk' => config('bckgrnd.preset_disk'),
    ]);
});