<?php

declare(strict_types=1);

namespace App\Support\Project;

/** Preserve old identities as importable originals; never merge or overwrite them. */
final class LegacyData
{
    public static function preserve(string $appData, string $destination): void
    {
        foreach (['dev.floor.stemmachine', 'FLOOR', 'floor', 'laravel', 'laravel-dev'] as $identity) {
            foreach (['storage/app/projects', 'storage/presets', 'storage/app/presets'] as $relative) {
                foreach (glob($appData.'/'.$identity.'/'.$relative.'/*.json') ?: [] as $path) {
                    if (!is_file($path) || filesize($path) > 16 * 1024 * 1024) continue;
                    $target = $destination.'/'.$identity.'/'.str_replace('/', '-', $relative).'/'.basename($path);
                    if (file_exists($target)) continue;
                    if (!is_dir(dirname($target))) mkdir(dirname($target), 0700, true);
                    ProjectFiles::atomicWrite($target, file_get_contents($path));
                }
            }
        }
    }
}
