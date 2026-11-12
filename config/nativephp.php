<?php

return [
    'version' => env('NATIVEPHP_APP_VERSION', '0.1.0'),
    'app_id' => env('NATIVEPHP_APP_ID', 'com.chrislanejones.bckgrndmsc'),
    'deeplink_scheme' => env('NATIVEPHP_DEEPLINK_SCHEME'),
    'author' => env('NATIVEPHP_APP_AUTHOR', 'Chris Lane Jones'),
    'copyright' => env('NATIVEPHP_APP_COPYRIGHT', 'Copyright © 2026 Chris Lane Jones'),
    'description' => env('NATIVEPHP_APP_DESCRIPTION', 'A hands-on stem machine for building, editing, and performing music.'),
    'website' => env('NATIVEPHP_APP_WEBSITE', 'https://bckgrnd-msc.netlify.app'),

    'provider' => \\App\\Providers\\NativeAppServiceProvider::class,

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
    ],

    // Disabled until a real, tested update feed is configured.
    'updater' => [
        'enabled' => env('NATIVEPHP_UPDATER_ENABLED', false),
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

    'queue_workers' => [
        'default' => [
            'queues' => ['default'],
            'memory_limit' => 128,
            'timeout' => 60,
            'sleep' => 3,
        ],
    ],

    'prebuild' => [
        'pnpm run build:engine',
        'pnpm run build',
    ],

    'postbuild' => [
        // Runtime assets must remain available to the packaged webview.
    ],

    'binary_path' => env('NATIVEPHP_PHP_BINARY_PATH', null),
];
