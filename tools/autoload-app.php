<?php

declare(strict_types=1);

/**
 * PSR-4 autoloading for `App\` alone, for the build-time exporters.
 *
 * The static (Netlify) build only needs the music and project classes under
 * `app/Support`, which use nothing from Laravel or NativePHP. Loading Composer's
 * autoloader instead would force a full `composer install` on the web build machine:
 * that installs `nativephp/desktop` and enforces the desktop's PHP platform version.
 * The web build must not depend on the desktop distribution (Night 6G, section 1).
 */
spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'App\\')) return;
    $path = __DIR__.'/../app/'.str_replace('\\', '/', substr($class, 4)).'.php';
    if (is_file($path)) require $path;
});
