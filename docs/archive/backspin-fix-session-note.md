# Backspin fix — session note (10-03/04-2026)

> **Archived 10-05-2026. This note is stale.** It was written mid-session on
> 10-03/04-2026 with the backspin fix still uncommitted. The fix landed in
> `e6fcd0d` ("fix: backspin reverses the capture, sweeps its real rate, and skips
> the stem bus", 10-03-2026), whose body carries the same four bugs. The "Next
> session" checklist is done or overtaken: the full test suite and clippy are part
> of every later commit's gates. The untracked `rolled_repo/` it mentions is no
> longer in the working tree. Moved out of PARKING_LOT.md so the open items there
> read as open.

Working tree has an uncommitted fix to `engine-core/src/lib.rs` for "backspin sounds
weird." Builds clean, four new guard tests pass (`cargo test --release --lib backspin`).
Stopped before the browser gate (`verify:audio`) and before committing — pick up there.

Found four stacked bugs in backspin, worse than the two already listed below (now
removed from the table, folded in here):

1. **It wasn't reversed at all.** `ReverseVoice`'s cursor started at the end of the
   captured buffer and counted down to 0. `Ring::take` already hands back the capture
   newest-first, so counting down replayed it in its *original* chronological order —
   forward, not backward. Fixed: cursor starts at 0 and counts up.
2. **The rate sweep was clamped to a constant 20x.** `exp_between` floors both ends at
   20 because it's written for filter frequencies (20 Hz = bottom of hearing). Used on
   a *playback rate*, 0.62 and 2.8 both became 20, so every backspin ran at a flat 20x
   and tore through 1.35 s of audio in ~67 ms. This was almost certainly the dominant
   cause of "weird." Fixed: rate sweep uses `geom` instead, uncapped.
3. **The deceleration stage was missing.** Reference sweeps 0.62 → 2.8 over 420 ms,
   *then* 2.8 → 1.15 over the next 240 ms, so the gesture winds up and eases back
   toward normal speed. The port only had the first stage and then held at 2.8x for
   the rest of the voice. Fixed: added the second ramp.
4. **Routing comment lied.** `Voice::stem()` said the reverse take "bypasses the stem
   faders" but routed it through `Stem::Arp`'s channel — fader, mute, solo and the
   kick's duck all applied. On a track with a quiet arp, backspin was quiet too; with
   arp muted, silent. Fixed: `stem()` now returns `Option<usize>`, `None` for the
   reverse voice, and `render_sample` sums it straight into the master bus bypassing
   every channel strip.

Also rewrote `synthetic_spin` (the fallback used when there's no audio yet to reverse):
it compared `i / n` — a 0..1 fraction — against breakpoints the reference gives in
*seconds* (0.06, 0.5, 0.66), so the sweep raced through its first 4% and crawled through
the rest. Added the missing 92→40 Hz thump oscillator, which the port had dropped
entirely. Same envelope-shape bug (steal `SPIN_FLOOR`/`geom`) applies to `spin_hiss`,
also rewritten to take an explicit `SpinShape` rather than borrowing `ReverseVoice`'s old
one-size envelope.

New types: `SpinShape` (rate_from/mid/to, ramp_up/down, peak, attack, hold_until,
release — all in seconds) and `ReverseVoice::flat()` for the two synthesized,
already-shaped buffers (synthetic spin, hiss) vs `ReverseVoice::new()` for the real
captured take.

**Next session:**
- Run `cargo test --release` (full suite, not just `backspin`) and `cargo clippy
  --all-targets` — only ran the targeted backspin tests before stopping.
- Run `pnpm run verify:audio` against a rebuilt wasm (`pnpm run build:engine`).
- Spot-check by ear: backspin on a track that's been playing a while (real-take path)
  and backspin right after load (synthetic fallback path).
- If clean, commit. HANDOFF.md's defect table and PARKING_LOT's #7/#8 (removed below)
  should get entries matching the pattern already used for this session's other fixes.
- There's an untracked `rolled_repo/` at the repo root I didn't create — unrelated to
  this fix, left alone, worth asking Chris what it is before anything touches it.
