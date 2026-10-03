<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;

/**
 * The app shell. The SPA mounts here; everything else lives under `/api`.
 */
Route::get('/', function (): \Illuminate\Contracts\View\View {
    return view('app');
});

/**
 * Deep links from the desktop app reopen the right track, so a saved window
 * position and a copied link both land on the same view.
 */
Route::get('/tracks/{id}', function (string $id): \Illuminate\Contracts\View\View {
    return view('app', ['initialTrack' => $id]);
})->where('id', '[a-z0-9_-]+');