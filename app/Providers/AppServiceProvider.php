<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // React uses the narrow sandboxed preload. NativePHP's optional Livewire
        // dispatcher is unused and otherwise injects a script outside our CSP.
        $this->app->bind(\Native\Desktop\Events\LivewireDispatcher::class, fn () => new class extends \Native\Desktop\Events\LivewireDispatcher {
            public function register(): void {}
        });
    }

    public function boot(): void
    {
        if (config('nativephp-internal.running') || $this->app->runningInConsole()) {
            config(['app.name' => 'bckgrnd-msc']);
            if (!config('nativephp-internal.running')) config(['app.url' => config('nativephp.website')]);
        }
    }
}
