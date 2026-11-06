<!DOCTYPE html>
<html lang="en" class="antialiased">
<head>
    <meta charset="utf-8">
    @php($nonce = base64_encode(random_bytes(18)))
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'nonce-{{ $nonce }}' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>bckgrnd-msc</title>
    <meta name="description" content="An EDM instrumental split into stems. Cut any part — the rest keeps playing.">
    <meta name="theme-color" content="#090a0c">
    @if(config('nativephp-internal.running'))
    <meta name="bckgrnd-native-token" content="{{ hash_hmac('sha256', 'bckgrnd-projects', (string) config('nativephp-internal.secret')) }}">
    @endif
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">

    {{-- Built by Vite from frontend/. Copied into public/build by `pnpm run build`. --}}
    {{-- The file names are fixed, so the build's date is the cache key: without it the
         browser kept reusing an old app.js after a rebuild. --}}
    @php($v = @filemtime(public_path('build/assets/app.js')) ?: 0)
    <link rel="stylesheet" href="/build/assets/app.css?v={{ $v }}">
    <script nonce="{{ $nonce }}">window.__BCKGRND__ = @json($initialTrack ?? null);</script>
</head>
<body>
    <div id="root"></div>

    {{--
        The audio engine is a Rust/WASM module loaded as an ES module from
        /wasm/. It must load after the page script so the root element exists;
        it is loaded lazily on first play rather than at boot, because an
        AudioContext cannot start before a user gesture anyway.
    --}}
    <script type="module" src="/build/assets/app.js?v={{ $v }}"></script>
</body>
</html>
