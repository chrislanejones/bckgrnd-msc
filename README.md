# bckgrnd-msc

![bckgrnd-msc: the transport with song parts and the master meter across the top, the library on the left, two decks and the eight stems with their states in the middle, and the master inspector on the right](screenshots/bckgrnd-msc.webp)

A stem machine. Eighteen tracks, eight stems each. Cut any stem and the rest of the
instrumental keeps playing, so you build the track yourself while it runs.

**Live:** https://bckgrnd-msc.netlify.app

The DSP is Rust compiled to WebAssembly, running inside an `AudioWorklet`. The music —
song form, note grid, swing, stem mix — is PHP. React draws the meters and sends intent,
and holds no audio state of its own.

The design rules every screen follows are in
**[docs/DESIGN_PHILOSOPHY.md](docs/DESIGN_PHILOSOPHY.md)**: music first, tactile
controls, clear feedback, progressive complexity. The six-night plan is in
**[docs/ROADMAP.md](docs/ROADMAP.md)**.

Design decisions live in **[docs/adr/](docs/adr/INDEX.md)**. Superseded notes are kept
in **[docs/archive/](docs/archive/README.md)** rather than deleted — each one says what
went stale about it.

## Quick start

```bash
./start.sh          # build what's stale, start what isn't running
./start.sh --stop   # stop both servers
```

| URL | What it is |
|---|---|
| `http://localhost:8080` | Laravel. The app plus a live `/api` that computes the library and song form per request. |
| `http://localhost:8090` | Static files only. No PHP in the request path. The same shape as the Netlify site. |

What `start.sh` does:

| Step | When it runs |
|---|---|
| `composer install`, `pnpm install` | The lockfile or manifest is newer than the install. |
| Rust engine (`build:engine`) | Anything in `engine-core/src` or `Cargo.toml` is newer than the `.wasm`. |
| App and worklet (`build`) | The frontend, the wasm or the build config changed. |
| Track library export | Anything in `app/Support/Music` changed. |
| The two servers | Only the ones that aren't already answering. They run detached, so closing the terminal doesn't stop them. |
| `--stop` | Stops whatever is listening on `:8080` and `:8090`, and nothing else. |

Logs go to `/tmp/floor-laravel.log` and `/tmp/floor-static.log`.

**Use `localhost`, not the machine's IP address.** `AudioWorklet` only exists in a secure
context, and plain HTTP on a LAN address is not one. Over the IP the page renders fine and
then never makes a sound.

## Deploy

Netlify serves the static build. Its build image has no Rust or `wasm-pack`, so the site
is built here and uploaded:

```bash
pnpm run build:netlify
netlify deploy --dir dist --no-build --prod
```

`build:netlify` builds the engine, the app and the static export, then puts only what a
static host should serve into `dist/`. Saved presets need Laravel, so they aren't
available on the live site. Nothing in the UI uses them yet.

The Netlify response headers block framing the app (clickjacking), embedded
plugin objects and cross-origin base URLs. The policy leaves JavaScript,
WebAssembly and AudioWorklet loading unchanged. These headers apply on the next
Netlify deployment; the local Laravel and static development servers do not
read `netlify.toml`.

## The screen

| Area | What's there |
|---|---|
| Transport (top, always visible) | Play/stop, the track, the song part and bar, the tempo, the master meter with a clip light, and whether the mix differs from the track as written. Nothing is saved yet, so it says so. |
| Library (left) | Tracks by section and style, with a star to keep favorites (stored in this browser only). On narrower screens it opens from the button in the transport. |
| Performance area (middle) | The two decks, the stems, the jog wheel and pads, loop, and mixing to the next track. |
| Inspector (right) | **Master**: tempo, swing, the isolators, filter, echo time, stereo and master level. Select a stem's name to see that stem instead. |
| Pattern drawer (bottom) | Opened from **Pattern** or the inspector. One stem's pattern across all 16 bars, with the playhead. Read-only for now. Escape closes it. |

On a phone the same panels show one view at a time: **Perform**, **Mix** and
**Edit**, from the tabs at the bottom. The transport stays at the top.

## The library

Three sections, each split into styles. Every track badge shows its bpm.

| Section | Style | Tracks | Tempo |
|---|---|---|---|
| EDM | House | Warehouse, Basement, Tunnel | 122–128 bpm |
| EDM | Deep | Night Drive, Glass | 110–116 bpm |
| EDM | Acid | Acid Line | 134 bpm |
| Lofi | Chillhop | Rain, Study, Porch | 76–92 bpm |
| Lofi | Dusty | Tape, Nightbus | 80–88 bpm |
| Lofi | Jazz | Kettle | 78 bpm |
| Breaks | Garage | Southside, Pirate | 132–134 bpm |
| Breaks | Breakbeat | Bricks, Rave Tape | 130–136 bpm |
| Breaks | Liquid DnB | Lowtide, Slipstream | 172–174 bpm |

Every track is a 16-bar form in four 4-bar parts: Intro, Groove, Break, Drop. The intro is
deliberately sparse — bar 2 is kick and hats, and the stab, lead and arp don't arrive
until bar 5. There's nothing to build if it starts full.

Clicking a track plays it. Nothing starts on page load.

## Stems

Eight per track. Keys 1–8 cut them in this order.

| Key | Stem | Notes |
|---|---|---|
| 1 | Kick | Its sub is tuned to the track's root. It ducks the stems under it, which is the pump. |
| 2 | Clap | |
| 3 | Hats | 808-style metal. Shaker, rimshot and congas ride this stem on the garage, breakbeat and lofi tracks. |
| 4 | Bass | Acid Line and Rave Tape run it through a four-pole ladder filter. |
| 5 | Stab | |
| 6 | Lead | Ladder filter on the acid tracks too. |
| 7 | Pad | |
| 8 | Arp | |

Each stem row has its icon and name up a spine on the left, its state in words, a
meter, the step pattern for the current bar, a fader, and one badge column: **Solo**
over **Cut**. Cut lights when the stem is silent for any reason, including another
stem's solo, and reads **In** while it's cut. Each stem has its own echo send, so
cutting a stem cuts its echo with it. Selecting the name opens the stem in the
inspector.

The state says why a stem is or isn't sounding:

| State | Meaning |
|---|---|
| Ready | Stopped. |
| Playing | Has notes in this bar. |
| Rests this bar | In the mix, but the song leaves it out of this bar (the stab, lead and arp wait for bar 5). |
| Cut | You cut it. |
| Solo | You soloed it. |
| Off: solo on Bass | Silent because another stem is soloed. |

Three group buttons above the stems: **Full mix**, **No drums**, **No music**.

## The decks

Two decks, A and B, each with a waveform drawn from the arrangement. One is live; the
other holds whatever is in Next. Cutting a stem thins the live waveform.

| On the waveform | What it does |
|---|---|
| Drag | Scratches. The playhead holds where you grabbed it and the drag sets the speed: back plays the recent past in reverse, holding still is silence. Let go and the song drops in at the step under the head. |
| Tap | Jumps to that point. |
| `[ ]` brackets | The four song parts, named along the bottom. The live part lights up. |

You can only scratch the live deck, and not while a mix is running.

### Jog wheel

| Gesture | What it does |
|---|---|
| Touch | Drags the tempo down, like a hand on a spinning record. Resting still keeps dragging. |
| Turn forward / back | Bends the tempo up / down. |
| Wind back 80°, or flick back fast | Backspin. |
| Let go | The tempo snaps back. The disc coasts to a stop (the coast is visual only). |
| Arrow keys / Space | Bend / backspin, when the wheel has focus. |

The label turns at 33⅓ rpm while the deck plays, except under reduced motion.

### Deck pads

| Pad | What it does |
|---|---|
| Cue | Jumps the playhead back to the start. |
| Brake | Slows the transport to a stop on a curve. |
| Echo | The echo throw: feeds the whole mix into the delay and opens the feedback up. |
| Bend + / Bend − | Pushes the tempo while held, then returns it. |
| Backspin | Reverses the last 1.35 s of output and spins it back. |

## Controls

| Control | What it does |
|---|---|
| Loop | 1, 2, 4, 8 or 16 bars, snapped to a bar boundary. Click the lit one to turn it off. |
| Echo time | 1/16, 1/8T, 1/8, 1/8. (default), 1/4, 1/4. — the stem echo's delay. Click the lit one to turn the echo off; what's already in it rings out. |
| Low / Mid / High | Isolators: low shelf 180 Hz, mid bell 1 kHz, high shelf 3.2 kHz. |
| Filter | One tape-style lowpass sweep, 240 Hz to 18 kHz, exponential under the finger. |
| Stereo | A balance fader. Left end is mono-left, the middle is full stereo, the right end is mono-right. |
| Tempo | Retimes the grid, the duck recovery and the delay together. |
| Swing | Pushes every other sixteenth late. |
| Master | Output level. |
| Master meter | Left and right peak of what leaves the engine, in the transport. Turns amber near the limiter. The **Clip** light holds for two seconds after any sample goes past full scale, which can only happen while a crossfade adds two decks together. |
| Reset | Every fader in this table has one. Tempo and swing go back to the track's own values; the rest to their defaults. Disabled when it's already there. |
| Space | Play / stop. |

The stem faders don't have a Reset badge.

## Mixing

| Control | What it does |
|---|---|
| Next | The track Auto mix will bring in. The idle deck always shows it. |
| Auto mix | Crossfades to Next. The new track starts on a phrase boundary of the old one (or the next bar, if the phrase is too far off), at the old tempo, then eases to its own tempo over about twelve seconds. |
| Continuous mix — stem swap | At bar 12 it hands over to Next, and each handover steps the groups on: full mix, no drums, no music. Runs until you turn it off. |
| Continuous mix — song after song | The same handover, with the groups left alone. |

## Sound

Besides the stems, the engine adds a few things of its own.

| What | Where it's heard |
|---|---|
| Transitions | A noise riser into the Drop, a crash on its downbeat, a downsweep into the Break. Darker and quieter on lofi. They sit outside the stems, so no cut or solo stops them, and they only fire when playback actually crosses the seam — not on a jump, and not when a loop wraps back to one. |
| Master chain | Stereo-linked compressor, saturator, the isolators and filter, then a safety limiter with a −0.3 dBFS ceiling. |
| Echo | A stereo ping-pong: repeats alternate left and right. |

## How it's split

The line between the three languages is the one architectural decision worth knowing
([ADR-001](docs/adr/001-php-owns-the-music-rust-owns-the-dsp-react-only-renders.md)):

| Layer | Owns | Where |
|---|---|---|
| PHP | The music: song form, note grid, swing, tempo, stem mix. The API serves arranged JSON. | `app/Support/Music/` |
| Rust → wasm | All DSP: oscillators, envelopes, filters, drums, the master bus, scratch and transitions. Renders events it's handed and never decides a note sequence. | `engine-core/` |
| React | Draws meters and sends intent. No audio state, no DSP, no musical clock. | `frontend/` |

Saved musical data and playback telemetry are kept apart. The parameters and the
project format that the UI, PHP and the MCP companion share are in
**[contracts/](contracts/README.md)**.

The DSP runs in an `AudioWorklet` rather than a `ScriptProcessorNode`, so the timing is
sample-accurate and nothing depends on the main thread keeping up. The worklet holds two
engines, one per deck.

Laravel is deliberately stateless: no sessions, no CSRF, no database. Presets are JSON
files on disk ([ADR-002](docs/adr/002-laravel-runs-stateless.md)).

## Scripts

| Command | What it does |
|---|---|
| `pnpm run build:engine` | Rust engine → `public/wasm/` via `wasm-pack`. |
| `pnpm run build` | Worklet and app → `public/build/`. |
| `pnpm run build:static` | The PHP-free shell, `public/index.html`. |
| `pnpm run build:netlify` | Engine, app and static export, assembled into `dist/`. |
| `pnpm run dev` | Vite dev server with the worklet on watch. |
| `composer test` | PHPUnit, Rust tests, parity, arrangement, the contract, `verify:audio` and `verify:ui`. The last two need the app running on `:8080`. |

## Checks

| Command | What it checks |
|---|---|
| `cargo fmt --check --manifest-path engine-core/Cargo.toml` | Formatting. |
| `cargo clippy --all-targets --manifest-path engine-core/Cargo.toml -- -D warnings` | Must be clean. |
| `cargo test --release --manifest-path engine-core/Cargo.toml` | The engine. |
| `pnpm run typecheck` | `tsc --noEmit`. |
| `composer test:php` | PHPUnit: the song form for every track, the API, the static export matching the API, presets, and the project contract. |
| `pnpm run check:contract` | The UI's project reader against the same fixtures as PHP's. |
| `pnpm run verify:ui` | The layout at five widths, keyboard focus, the stem states, the inspector, the drawer and the phone views. |
| `pnpm run verify:audio` | Drives the real worklet in Chromium and asserts audio. |
| `pnpm run verify:static` | The same, against the static build, plus no API calls. |
| `php tools/check-arrangement.php` | The 16-bar form. |
| `php tools/compare-with-original.php tools/reference.json` | Parity with `old/`. |

`verify:audio` taps the worklet through an `AnalyserNode` into a zero-gain sink. It proves
correct samples leave the worklet. It does not prove audio reaches a speaker, and it can't
see the audio thread's console — a throw inside `process()` is swallowed by the browser,
which is why there's an explicit error channel to the UI. It also can't jump the
playhead, so the transitions and most of the percussion are covered by the Rust tests
only.

The browser checks look for Chromium in Playwright's cache. Set
`PLAYWRIGHT_CHROMIUM=/path/to/chrome` to use another one.

`/probe.html` is the audio probe for a new shell (a NativePHP window, a packaged
build, a phone): it boots the engine, plays a moment of Warehouse, and reports
whether sound came out. See [docs/NIGHT6_INVENTORY.md](docs/NIGHT6_INVENTORY.md).

`window.__BCKGRND_DIAG__()` prints context state, sample rate, worklet availability,
meters and the last error.

The engine's defects found and fixed during the port, and the audio notes behind them,
are written up in [HANDOFF.md](HANDOFF.md). Open items are in
[PARKING_LOT.md](PARKING_LOT.md).

## Coming next: a mobile app

I'm planning to package this as a phone app with NativePHP. The desktop side of
NativePHP (`nativephp/laravel`, `nativephp/electron`) is already in `composer.json`; mobile
is a separate package and isn't set up yet. The open questions are in
[PARKING_LOT.md](PARKING_LOT.md).

## `old/`

`old/` is the first version of this: a TanStack Start app running the engine in Web
Audio and TypeScript, deployed at `bckgrndmsc.grok.me`. It's the reference for how this
should sound and for the musical content of the original twelve tracks —
`tools/compare-with-original.php` checks the arrangement against a dump of its source, so
the comparison is against something independent rather than against this port's own
output.

It still runs on its own, nothing here reads from it at runtime, and it doesn't need to be
started to use this app.

## License

MIT. See [LICENSE](LICENSE).
