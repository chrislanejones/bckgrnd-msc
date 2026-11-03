<?php

declare(strict_types=1);

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

/**
 * Boots the real application from bootstrap/app.php, so the API tests go through the
 * same middleware stack the app and the NativePHP shell use.
 */
abstract class TestCase extends BaseTestCase
{
}
