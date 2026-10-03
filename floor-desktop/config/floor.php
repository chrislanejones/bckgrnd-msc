<?php

declare(strict_types=1);

use App\Support\Music\Library;

/**
 * Application-specific configuration.
 *
 * `preset_disk` is the one knob that differs between the two ways this runs: in a
 * packaged desktop build the presets belong to the user's own application data
 * directory, while `php artisan serve` writes to the local filesystem.
 */
return [

    /*
    |--------------------------------------------------------------------------
    | Preset storage
    |--------------------------------------------------------------------------
    |
    | Where saved mixes are written. The NativePHP bundle sets this to the
    | platform application-data directory so presets survive a rebuild; plain
    | `php artisan serve` falls back to the local disk.
    |
    */

    'preset_disk' => env('FLOOR_PRESET_DISK', 'local'),

    /*
    |--------------------------------------------------------------------------
    | Audio engine
    |--------------------------------------------------------------------------
    |
    | The Rust/WASM module is served from here. Kept in config so the packaged
    | app and the dev server agree on one path.
    |
    */

    'engine' => [
        'path' => env('FLOOR_ENGINE_PATH', '/wasm/floor_engine.js'),
        'worklet' => env('FLOOR_WORKLET_PATH', '/wasm/engine-worklet.js'),
        'sample_rate' => (int) env('FLOOR_SAMPLE_RATE', 0), // 0 = whatever the device gives us
    ],

    /*
    |--------------------------------------------------------------------------
    | Library
    |--------------------------------------------------------------------------
    |
    | The built-in track library. Present so a config dump or a health check can
    | report what is installed without loading the whole thing.
    |
    */

    'library' => [
        'tracks' => count(Library::all()),
        'stems' => Library::STEMS,
    ],

];