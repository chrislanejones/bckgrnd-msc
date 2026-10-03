<!DOCTYPE html>
<html lang="en" class="antialiased">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>bckgrnd-msc</title>
    <meta name="description" content="An EDM instrumental split into stems. Cut any part — the rest keeps playing.">
    <meta name="theme-color" content="#090a0c">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">

    {{-- Built by Vite from frontend/. Copied into public/build by `npm run build`. --}}
    <link rel="stylesheet" href="/build/assets/app.css">
    <script>window.__BCKGRND__ = @json($initialTrack ?? null);</script>
</head>
<body>
    <div id="root"></div>

    {{--
        The audio engine is a Rust/WASM module loaded as an ES module from
        /wasm/. It must load after the page script so the root element exists;
        it is loaded lazily on first play rather than at boot, because an
        AudioContext cannot start before a user gesture anyway.
    --}}
    <script type="module" src="/build/assets/app.js"></script>
</body>
</html>