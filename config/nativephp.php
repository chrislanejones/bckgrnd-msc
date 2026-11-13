<?php

return [
    /**
     * The version of your app.
     * It is used to determine if the app needs to be updated.
     * Increment this value every time you release a new version of your app.
     */
    'version' => env('NATIVEPHP_APP_VERSION', '0.6.0-rc.1'),

    /**
     * The ID of your application. This should be a unique identifier
     * usually in the form of a reverse domain name.
     * For example: com.nativephp.app
     */
    'app_id' => env('NATIVEPHP_APP_ID', 'com.chrislanejones.bckgrndmsc'),

    /**
     * If your application allows deep linking, you can specify the scheme
     * to use here. This is the scheme that will be used to open your
     * application from within other applications.
     * For example: "nativephp"
     *
     * This would allow you to open your application using a URL like:
     * nativephp://some/path
     */
    'deeplink_scheme' => env('NATIVEPHP_DEEPLINK_SCHEME'),
    /**
     * The author of your application.
     */
    'author' => env('NATIVEPHP_APP_AUTHOR', 'Chris Lane Jones'),

    /**
     * The copyright notice for your application.
     */
    'copyright' => env('NATIVEPHP_APP_COPYRIGHT', 'Copyright © 2026 Chris Lane Jones'),

    /**
     * The description of your application.
     */
    'description' => env('NATIVEPHP_APP_DESCRIPTION', 'A hands-on stem machine for building, editing, and performing music.'),

    /**
     * The Website of your application.
     */
    'website' => env('NATIVEPHP_APP_WEBSITE', 'https://bckgrnd-msc.netlify.app'),

    /**
     * The default service provider for your application. This provider
     * takes care of bootstrapping your application and configuring
     * any global hotkeys, menus, windows, etc.
     */
    'provider' => \App\Providers\NativeAppServiceProvider::class,

    /**
     * A list of environment keys that should be removed from the
     * .env file when the application is bundled for production.
     * You may use wildcards to match multiple keys.
     */
    'cleanup_env_keys' => [
        'AWS_*',
        'AZURE_*',
        'GITHUB_*',
        'DO_SPACES_*',
        '*_SECRET',
        'ZEPHPYR_*',
        'NATIVEPHP_UPDATER_PATH',
        'NATIVEPHP_APPLE_ID',
        'NATIVEPHP_APPLE_ID_PASS',
        'NATIVEPHP_APPLE_TEAM_ID',
        'NATIVEPHP_AZURE_PUBLISHER_NAME',
        'NATIVEPHP_AZURE_ENDPOINT',
        'NATIVEPHP_AZURE_CERTIFICATE_PROFILE_NAME',
        'NATIVEPHP_AZURE_CODE_SIGNING_ACCOUNT_NAME',
    ],

    // Keep public/build: the packaged webview serves the frontend from it.
    'cleanup_exclude_files' => [
        'build',
        'temp',
        'content',
        'node_modules',
        '*/tests',
        'old',
        '.git',
        '.netlify',
        'engine-core/target',
        'docs',
        'bootstrap/cache/*.php',
        'storage/logs/*',
        'storage/app/projects',
        'storage/app/recovery',
        '.claude',
        '.agents',
        '.playwright-mcp',
        'tests',
        'tools',
        'floor-desktop',
        '.env*',
        '*/.env*',
        'frontend',
        'scripts',
        'engine-core',
        'SESSION_LOG.md',
        'PARKING_LOT.md',
        'public/build/*.map',
        'public/build/assets/*.map',
        'phpunit.xml*',
        '.phpunit*',
        'vite.config.ts',
        'tsconfig*.json',
        'package.json',
        'pnpm-lock.yaml',
        'netlify.toml',
        'start.sh',
        'screenshots',
    ],

    // Disabled until a real, tested update feed is configured.
    'updater' => [
        /**
         * Whether or not the updater is enabled. Please note that the
         * updater will only work when your application is bundled
         * for production.
         */
        'enabled' => false,

        /**
         * The updater provider to use.
         * Supported: "github", "s3", "spaces"
         */
        'default' => env('NATIVEPHP_UPDATER_PROVIDER', 'github'),

        'providers' => [
            'github' => [
                'driver' => 'github',
                'repo' => env('GITHUB_REPO'),
                'owner' => env('GITHUB_OWNER'),
                'token' => env('GITHUB_TOKEN'),
                'vPrefixedTagName' => env('GITHUB_V_PREFIXED_TAG_NAME', true),
                'private' => env('GITHUB_PRIVATE', false),
                'channel' => env('GITHUB_CHANNEL', 'latest'),
                'releaseType' => env('GITHUB_RELEASE_TYPE', 'draft'),
            ],
            's3' => [
                'driver' => 's3',
                'key' => env('AWS_ACCESS_KEY_ID'),
                'secret' => env('AWS_SECRET_ACCESS_KEY'),
                'region' => env('AWS_DEFAULT_REGION'),
                'bucket' => env('AWS_BUCKET'),
                'endpoint' => env('AWS_ENDPOINT'),
                'path' => env('NATIVEPHP_UPDATER_PATH', null),
            ],
            'spaces' => [
                'driver' => 'spaces',
                'key' => env('DO_SPACES_KEY_ID'),
                'secret' => env('DO_SPACES_SECRET_ACCESS_KEY'),
                'name' => env('DO_SPACES_NAME'),
                'region' => env('DO_SPACES_REGION'),
                'path' => env('NATIVEPHP_UPDATER_PATH', null),
            ],
        ],
    ],

    /**
     * The queue workers that get auto-started on your application start.
     */
    'queue_workers' => [],

    'prebuild' => [
        'pnpm run build:engine',
        'pnpm run build',
    ],

    'postbuild' => [
        // Runtime assets must remain available to the packaged webview.
    ],

    'binary_path' => env('NATIVEPHP_PHP_BINARY_PATH', null),
];
