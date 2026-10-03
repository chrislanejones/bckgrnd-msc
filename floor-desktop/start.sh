#!/bin/sh
# Start FLOOR for local development.
#
# Brings up two servers, because the app has two shapes and you may want either:
#
#   :8080  Laravel. The frontend plus a live /api that computes the track library
#          and song form per request, and writes saved presets to disk.
#   :8090  Static files only. No PHP in the request path; the library is read from
#          public/library/*.json. This is the shape you would deploy to a CDN.
#
# Both are bound to 0.0.0.0, and neither needs anything beyond the build outputs.
#
# Use `localhost`, not the machine's IP address. `AudioWorklet` only exists in a
# secure context, and plain http on a LAN address is not one — the page would load and
# then produce no sound at all.
#
# Usage: ./start.sh          start whatever is not already running
#        ./start.sh --stop   stop both
set -eu
cd "$(dirname "$0")"

LARAVEL_PORT=8080
STATIC_PORT=8090

stop() {
  pkill -f "artisan serve" 2>/dev/null || true
  pkill -f "php -S 0.0.0.0:$STATIC_PORT" 2>/dev/null || true
  echo "stopped"
  exit 0
}

[ "${1:-}" = "--stop" ] && stop

up() {
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$1/" && return 0
  return 1
}

# --- Build anything missing, so a fresh clone works from one command.
if [ ! -f vendor/autoload.php ]; then
  echo "==> composer install"
  composer install --no-interaction
fi

if [ ! -d node_modules ]; then
  echo "==> pnpm install"
  pnpm install
fi

if [ ! -f public/wasm/floor_engine_bg.wasm ]; then
  echo "==> building the Rust engine (wasm-pack)"
  pnpm run build:engine
fi

if [ ! -f public/build/assets/app.js ] || [ ! -f public/build/engine-worklet.js ]; then
  echo "==> pnpm run build"
  pnpm run build
fi

if [ ! -f public/library/index.json ]; then
  echo "==> exporting the track library"
  php tools/export-library.php public/library
fi

# --- Laravel.
if up "$LARAVEL_PORT"; then
  echo "already up: http://localhost:$LARAVEL_PORT"
else
  echo "==> starting Laravel on :$LARAVEL_PORT"
  php artisan serve --host=0.0.0.0 --port="$LARAVEL_PORT" >/tmp/floor-laravel.log 2>&1 &
fi

# --- Static.
if up "$STATIC_PORT"; then
  echo "already up: http://localhost:$STATIC_PORT"
else
  echo "==> starting the static server on :$STATIC_PORT"
  php -S "0.0.0.0:$STATIC_PORT" -t public >/tmp/floor-static.log 2>&1 &
fi

# Give both a moment, then report rather than assuming.
sleep 2
for port in "$LARAVEL_PORT" "$STATIC_PORT"; do
  if up "$port"; then
    echo "  ready  http://localhost:$port"
  else
    echo "  FAILED http://localhost:$port  (see /tmp/floor-*.log)"
  fi
done

echo
echo "Open http://localhost:$LARAVEL_PORT — not the IP address; see the note in this script."
