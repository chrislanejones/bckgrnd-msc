# FLOOR desktop — handoff

A port of the FLOOR stem-machine music app from Web Audio/TypeScript to **Rust (WASM) + Laravel + NativePHP**, plus a PHP-free static web build.

The reference implementation is the sibling directory `../original/` — a TanStack Start app still running the Web Audio engine, deployed at `bckgrndmsc.grok.me`. Treat it as the authority on sound and on musical content. It is not modified by anything here.

---

## Where it runs

```bash
./start.sh          # start whatever isn't already running
./start.sh --stop   # stop both
```

| URL | What it is |
|---|---|
| `http://localhost:8080` | Laravel. React app plus a live `/api` that computes the track library and song form per request. |
| `http://localhost:8090` | Static files only. No PHP in the request path; reads `public/library/*.json`. The shape you'd deploy to a CDN. |

Both bind `0.0.0.0`. Logs go to `/tmp/floor-laravel.log` and `/tmp/floor-static.log`.

> **Use `localhost`, not the machine's IP.** `AudioWorklet` only exists in a secure context, and plain HTTP on a LAN address is not one. Over the IP the page renders but the engine can never boot — no sound, and a confusing error. `localhost` and `127.0.0.1` are both secure contexts.

`start.sh` also builds whatever is missing, so a fresh clone comes up with one command. It is idempotent: it probes each port and starts only what is down, so running it when things are already up is a no-op.

---

## The one architectural decision that matters

Responsibility is split along a hard line:

- **PHP owns the music.** Song form (Intro/Groove/Break/Drop), the note grid, swing, tempo, and the stem mix live in `app/Support/Music/*.php`. The API serves arranged JSON.
- **Rust/WASM owns all DSP.** Every oscillator, envelope, filter, drum and the entire master bus live in `engine-core/`. It never sees a note *sequence* decision — only rendered events.
- **React renders meters and sends intent.** It holds no audio state and does no DSP.

The DSP runs inside an `AudioWorklet`, not a `ScriptProcessorNode`, so timing is sample-accurate and there's no main-thread scheduling jitter.

---

## Commands

```bash
# Rust engine + tests
cargo test --release --manifest-path engine-core/Cargo.toml
cargo clippy --all-targets --manifest-path engine-core/Cargo.toml   # must be 0 warnings

# Frontend
pnpm run typecheck          # tsc --noEmit
pnpm run build              # worklet + app
pnpm run build:static       # emit public/index.html, PHP-free
pnpm run verify:audio       # drives the real worklet in Chromium, asserts audio
pnpm run verify:static      # same, against the static build

# PHP checks
php tools/check-arrangement.php      # musical sanity of the 16-bar form
php tools/compare-with-original.php tools/reference.json   # parity vs the original

# Everything
composer test
```

`verify:audio` and `verify:static` tap the worklet with an AnalyserNode into a **zero-gain sink**. They prove correct samples leave the worklet; they never prove audio reaches a speaker. They also cannot see the audio thread's `console` — a throw inside `process()` is swallowed by the browser. Hence the explicit error channel (`EngineHost.onError` → UI) and `runSafely` in the worklet.

`window.__FLOOR_DIAG__()` prints an audio diagnostic table: context state, sample rate, worklet availability, meters, last error.

---

## Layout

```
engine-core/          Rust DSP, compiled to wasm
  src/tone.rs         pitched voices: oscillators, envelopes, filter sweeps, stereo spread
  src/drums.rs        kick, clap, hats
  src/mixer.rs        stem buses, ducker, master chain
  src/dsp.rs          biquads, ADSR, delay, compressor, reverb, one-poles
  src/lib.rs          Engine: transport, voice pool, scheduling
  src/transport.rs    step clock and swing
  src/track.rs        Stem enum, event types, serde
  tests/              low_end, stem_balance, stem_coverage, sample_rates, backend_arrangements

app/Support/Music/    the music, in PHP
  Library.php         the 12 tracks: grooves, mixes, tempo, swing
  Arranger.php        16-bar form: Intro / Groove / Break / Drop
  Track.php Phrase.php NoteEvent.php ArrangedTrack.php Pitch.php

frontend/
  app.tsx             the whole UI
  worklets/           two-deck AudioWorklet + globals polyfill
  lib/                engine host, API client, types, static/API switch
  styles.css

tools/                verify-audio, verify-static, export-library, compare-with-original,
                      check-arrangement, dump-reference
```

---

## Audio notes worth knowing

**The master chain, in order.** This ordering is load-bearing and was wrong at one point during the port:

```
stems ─┬─────────────────────────────────────────► hp 28 Hz Q0.7
       ├─ pre 380 Hz ─► room ─► wet 0.07 ─────────┤
       ├─ echo hp 240 Hz ─► throw ─► delay ─► wet ─┤
       └─ per-stem sends ──────────────► delay ───┘
                                                    ▼
         hp 28 ─► compressor ─► saturator ─► dry ─► low ─► mid
               ─► high ─► tape sweep ─► recorder ─► master 0.78
```

Compression and saturation happen **before** the EQ, on the summed signal. That is what holds the kick and bass down before they reach the clipper. Saturation runs at 2× (linear interpolate up, saturate both points, average down) — a 1× `tanh` folds every harmonic it generates back into the audible band as aliasing, worst exactly where the signal is hottest.

**Stereo spread.** Wide voices build one oscillator per note and pan it at `(i / (n-1)) * 1.1 - 0.55`, so a chord spreads left to right. Detune is a per-oscillator list with fallback to the last entry, matching the original's `detune[i] ?? detune[len-1]`. Two voicings use a unison: the pad doubles every note (`2N` wide), and the **house lead doubles its single note** into a stereo pair — that unison is the entire character of the sound. An earlier version doubled every note symmetrically and mirrored the pans; that was wrong and sounded worse.

**Filter sweeps** ramp `fStart → fPeak` over `f_attack`, then `fPeak → fEnd` exponentially across the note's hold, timed from `Adsr::release_starts_at()`. The port originally sat at peak then *jumped* at release, which left long pads bright and clicking.

**Reverb is an approximation, on purpose.** The original convolves a 0.35 s decaying-noise IR at 7% wet. A real 16 800-tap convolution costs ~800 M MACs/s, which an audio thread cannot afford, so this synthesises an equivalent: 4 parallel combs into 2 series allpasses, per channel, feedback solved for RT60 ≈ 0.32 s, right channel offset for width. Not sample-identical to the original. Watch the feedback solve — dividing by the sample rate when you shouldn't gives a gain of ~1.0 and a room that never dies.

**Every filter is per-channel state** (`StereoBiquad`). A single biquad alternated left-then-right shares one delay line between the two, so the channels contaminate each other — on a 180 Hz shelf with ~9 ms memory that's enough to hollow out the low end.

---

## Things that were wrong and are now guarded by tests

These were real defects found by measurement, not taste. Each has a test.

| Defect | Guard |
|---|---|
| Master chain missing its 28 Hz highpass, compressor, and reverb; saturator underdriven and after the EQ instead of before | `mixer.rs` tests: compressor holds the sum, room rings after input stops, echo lengthens the delay tail |
| Every EQ/filter shared one biquad between L and R | `StereoBiquad` |
| Reverb feedback solved with an extra `÷ sample_rate`, so the room never decayed | the stop test asserting silence after Stop |
| Stereo unison missing from the house lead; pad not doubled; chord panning mirrored | `a_chord_spreads_left_to_right`, `the_pad_doubles_every_note`, `the_house_lead_is_a_stereo_unison` |
| Auto-mix never started the incoming deck — crossfaded a gain on a silent engine | deck label check in the browser pass |
| Panel assumed deck A was always live, so labels went stale after a handover | `liveDeck` state |

**A test that was measuring noise.** The bass low-band check read 70%, then 58% for the same signal. Cause: one Goertzel over ~1.4 M samples has sub-1 Hz resolution, so every probe sat in its neighbours' leakage skirt and the result depended on where the render started and stopped. It now averages 4096-sample windows and reads a stable 70.0%. If you add spectral tests, window them.

**A test that was testing taste.** `check-arrangement.php` originally required 4 stems per bar. It failed on `deep` and `acid`, whose voicings are built to sit *above* their own fundamental (`acid` sets `fStart = max(80, freq * 1.1)`, putting the filter corner above the note). Both match the deployed engine exactly. The floor is now 2.

---

## Don't make these changes

**Do not "fix" the sparse intro.** Bar 2 is kick and hats only; stab, lead and arp don't arrive until bar 5 (~7.6 s). That is deliberate. The app asks you to un-mute stems and build the track yourself, and an intro that arrives already full leaves nothing to add. An earlier version filled those bars in to satisfy a min-stems rule, and it made the music worse — busier, with the melodies crowded out. `Arranger.php` and `check-arrangement.php` both carry comments saying so.

**Do not raise the fader to "fix" the bass.** Cutting a stem can leave the mix *louder*, because the master compressor is holding the sum down: less signal in, less gain reduction, so the survivors come out hotter. That is the compressor working. It also means "muting a stem lowers RMS" is not a valid invariant here, and a test asserting it will fail for the right reason.

**Do not expect Rust to improve timbre.** Same DSP ported, so equivalence is the honest target. The wins are sample-accurate timing, no `ScriptProcessorNode`, and a fixed voice pool. The deployed original sounds good; match it rather than exceed it.

---

## Known gaps

- **`native:build` / `native:install` are unverified.** No Electron toolchain in the Linux sandbox. The composer `build` script invokes them, so a full desktop build is untested end to end. Note that NativePHP's own shell hardcodes `npm ci` inside `vendor/nativephp/electron/resources/js/` — npm must be installed alongside pnpm. It does not touch the project lockfile.
- **Reverb is not bit-accurate** with the original's convolution. See above.
- **The scope samples one point per frame at 60 Hz**, so it aliases any musical pitch. The original uses an `AnalyserNode` over 1024 samples. Cosmetic only.
- **`original/` is the reference**, not a sibling to keep in sync. It is a separate app and nothing here writes to it.

## Parity with the original

`php tools/compare-with-original.php tools/reference.json` asserts **metadata and the groove sections** match exactly — 180 checks across 12 tracks. It deliberately does not assert the intro and break, because those are arrangement decisions this port owns; it reports the divergences instead.

`tools/reference.json` is a dump of the original's arranged output. Regenerate it from the original's TypeScript source — the point is that the reference comes from `music.ts` rather than from the PHP port, so the comparison is against something independent:

```bash
node tools/dump-reference.mjs ../original/src/lib/music.ts tools/reference.json
php tools/compare-with-original.php tools/reference.json
```

`music.ts` is self-contained and imports nothing, which is why Node can load it directly with type stripping. Never edit `reference.json` by hand, and never regenerate it from this port — that would make the check compare the port against itself.
