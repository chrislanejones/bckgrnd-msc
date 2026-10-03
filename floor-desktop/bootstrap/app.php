<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

/**
 * The Laravel application bootstrap.
 *
 * A NativePHP desktop build boots this same kernel in a background PHP process and
 * serves it to the webview, so nothing here is aware of whether it is running on
 * the user's machine or on a server.
 */
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // This app is deliberately stateless. There are no accounts, no login, and
        // no database — saved mixes are JSON files on the user's own disk — so a
        // session store would add a database dependency for nothing, and CSRF
        // protection protects a session that does not exist. Both are removed from
        // the web group, leaving a stack that works with no persistence at all.
        $middleware->web(remove: [
            \Illuminate\Cookie\Middleware\EncryptCookies::class,
            \Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse::class,
            \Illuminate\Session\Middleware\StartSession::class,
            \Illuminate\View\Middleware\ShareErrorsFromSession::class,
            \Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class,
            \Illuminate\Session\Middleware\AuthenticateSession::class,
        ]);

        // The API is same-origin within the packaged app, but the Vite dev server
        // runs on a different port, so CORS has to be allowed during development.
        $middleware->api(prepend: [
            Illuminate\Http\Middleware\HandleCors::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // The API is consumed by a local desktop webview, never a browser, so a
        // stack-trace-free JSON body is always the right response.
        $exceptions->shouldRenderJsonWhen(
            static fn (Request $request): bool => $request->is('api/*') || $request->expectsJson(),
        );

        $exceptions->render(function (Throwable $e, Request $request) {
            // Defer to the framework for anything it already renders correctly:
            // validation failures are a 422 with a field map, and an unmatched route
            // is a 404. Wrapping those into a generic 500 would break the client's
            // error handling for no gain.
            if (
                ! $request->expectsJson()
                || $e instanceof ValidationException
                || $e instanceof HttpExceptionInterface
            ) {
                return null;
            }

            // Everything else is a genuine bug. Report it as JSON with the file and
            // line, because the NativePHP devtools window is the only debugger here.
            return response()->json([
                'message' => $e->getMessage(),
                'exception' => $e::class,
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ], 500);
        });
    })->create();