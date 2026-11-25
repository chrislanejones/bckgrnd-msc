<?php

declare(strict_types=1);

namespace Tests\Unit;

use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * NativePHP copies .env into the desktop app and removes only the keys that
 * `cleanup_env_keys` names. Secret-shaped keys must match; the keys the app runs
 * on must not.
 */
final class NativeEnvCleanupTest extends TestCase
{
    /** @return list<string> */
    private static function patterns(): array
    {
        $config = require __DIR__.'/../../config/nativephp.php';

        return $config['cleanup_env_keys'];
    }

    private static function removed(string $key): bool
    {
        return Str::is(self::patterns(), $key);
    }

    /** @return array<string, array{string}> */
    public static function secretKeys(): array
    {
        return array_map(fn ($k) => [$k], array_combine($k = [
            'DB_PASSWORD', 'REDIS_PASSWORD', 'MAIL_PASSWORD', 'MAIL_USERNAME', 'GITHUB_TOKEN',
            'NETLIFY_AUTH_TOKEN', 'NPM_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
            'STRIPE_KEY', 'AWS_SECRET_ACCESS_KEY', 'PUSHER_APP_SECRET', 'SENTRY_LARAVEL_DSN',
        ], $k));
    }

    /** @return array<string, array{string}> */
    public static function keptKeys(): array
    {
        return array_map(fn ($k) => [$k], array_combine($k = [
            'APP_NAME', 'APP_ENV', 'APP_KEY', 'APP_DEBUG', 'APP_URL', 'DB_CONNECTION',
            'BCKGRND_ENGINE_PATH', 'BCKGRND_SAMPLE_RATE', 'NATIVEPHP_APP_VERSION',
        ], $k));
    }

    #[DataProvider('secretKeys')]
    public function test_secret_shaped_keys_are_stripped(string $key): void
    {
        $this->assertTrue(self::removed($key), "$key would ship in the desktop app");
    }

    #[DataProvider('keptKeys')]
    public function test_keys_the_app_runs_on_are_kept(string $key): void
    {
        $this->assertFalse(self::removed($key), "$key would be stripped from the desktop app");
    }
}
