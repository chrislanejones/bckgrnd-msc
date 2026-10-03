# bckgrnd-msc

A stem machine. Twelve tracks, eight stems each. Cut any stem and the rest of the
instrumental keeps playing, so you build the track yourself while it runs.

The DSP is Rust compiled to WebAssembly, running inside an `AudioWorklet`. The music —
song form, note grid, swing, stem mix — is PHP. React draws the meters and sends intent,
and holds no audio state of its own.

## Quick start

```bash
./start.sh          # start whatever isn't already running
./start.sh --stop   # stop both
```

| URL | What it is |
|---|---|
| `http://localhost:8080` | Laravel. The app plus a live `/api` that computes the library and song form per request. |
| `http://localhost:8090` | Static files only. No PHP in the request path. The shape you'd put on a CDN. |

`start.sh` builds anything missing — composer, pnpm, the Rust engine, the track library —
so a fresh clone comes up from one command.

**Use `localhost`, not the machine's IP address.** `AudioWorklet` only exists in a secure
context, and plain HTTP on a LAN address is not one. Over the IP the page renders fine and
then never makes a sound.

## The library

| Group | Flavour | Tracks | Tempo |
|---|---|---|---|
| EDM | house | warehouse, basement, tunnel | 122–128 bpm |
| EDM | deep | drive, glass | 110–116 bpm |
| EDM | acid | acid | 134 bpm |
| Lofi | lofi | rain, study, porch, tape, nightbus, kettle | 74–92 bpm |

Every track is a 16-bar form: Intro, Groove, Break, Drop. The intro is deliberately
sparse — bar 2 is kick and hats, and the stab, lead and arp don't arrive until bar 5.
There's nothing to build if it starts full.

## Stems

Eight per track: kick, clap, hats, bass, stab, lead, pad, arp.

- Mute and solo per stem, with a fader each.
- The kick ducks the stems that sit under it, which is where the pump comes from.
- Each stem has its own delay send, so cutting a stem cuts its echo with it.

## Controls

| Control | What it does |
|---|---|
| Tempo | Retimes the grid, the duck recovery and the delay together. |
| Swing | Pushes every other sixteenth late. |
| Loop | Loop length in bars, snapped to a bar boundary. |
| Filter | One tape-style lowpass sweep, 240 Hz to 18 kHz, exponential under the finger. |
| EQ | Low shelf 180 Hz, mid bell 1 kHz, high shelf 3.2 kHz. |
| Echo throw | Feeds the whole mix into the delay and opens the feedback up. |
| Stereo | A balance fader. Left end is mono-left, the middle is full stereo, the right end is mono-right. |
| Vinyl brake | Slows the transport to a stop on a curve. |
| Backspin | Reverses the last quarter-second of output and spins it back. |
| Nudge | Shoves the transport ahead or behind, then returns it. |
| Cue | Jumps the playhead back to the start. |
| Next | The track Auto mix will bring in. Deck B always shows it. |
| Auto mix | Crossfades to Next. The new track starts on a phrase boundary of the old one, at the old tempo, then eases to its own tempo over about twelve seconds. |
| Continuous | Keeps doing that on its own. At bar 12 it hands over to Next, and each handover steps the stem groups on: full mix, no drums, no music. It runs until you turn it off. |

There are two decks. Deck A starts on the first track, deck B holds whatever is in Next.
A mix brings B up and hands over, and the panel follows whichever deck is live rather than
assuming it's the first. Clicking a track plays it. Nothing starts on page load.

## How it's split

The line between the three languages is the one architectural decision worth knowing:

- **PHP owns the music.** `app/Support/Music/` holds the song form, the note grid, swing,
  tempo and the stem mix. The API serves arranged JSON.
- **Rust owns all the DSP.** `engine-core/` holds every oscillator, envelope, filter, drum
  and the whole master bus. It never makes a decision about a note *sequence* — it only
  renders events it's handed.
- **React renders.** `frontend/` draws meters and sends intent. No audio state, no DSP.

The DSP runs in an `AudioWorklet` rather than a `ScriptProcessorNode`, so the timing is
sample-accurate and nothing depends on the main thread keeping up.

## Checks

```bash
cargo test --release --manifest-path engine-core/Cargo.toml
cargo clippy --all-targets --manifest-path engine-core/Cargo.toml   # must be clean

pnpm run typecheck
pnpm run build
pnpm run verify:audio      # drives the real worklet in Chromium and asserts audio
pnpm run verify:static     # same, against the static build

php tools/check-arrangement.php                              # the 16-bar form
php tools/compare-with-original.php tools/reference.json      # parity with old/
```

`verify:audio` taps the worklet through an `AnalyserNode` into a zero-gain sink. It proves
correct samples leave the worklet. It does not prove audio reaches a speaker, and it can't
see the audio thread's console — a throw inside `process()` is swallowed by the browser,
which is why there's an explicit error channel to the UI.

`window.__BCKGRND_DIAG__()` prints context state, sample rate, worklet availability,
meters and the last error.

Most of the audio decisions, and the defects that have been found and fixed in the engine,
are written up in [HANDOFF.md](HANDOFF.md).

## `old/`

`old/` is the first version of this: a TanStack Start app running the engine in Web
Audio and TypeScript, deployed at `bckgrndmsc.grok.me`. It's the reference for how this
should sound and for the musical content — `tools/compare-with-original.php` checks the
arrangement against a dump of its source, so the comparison is against something
independent rather than against this port's own output.

It still runs on its own, nothing here reads from it at runtime, and it doesn't need to be
started to use this app.
