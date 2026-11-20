# ADR-022: A scene may carry an explicit crash accent, off by default and never automatic
Date: 2026-11-19   Status: draft

## Context
ADR-008 fires the crash only on the Drop's natural crossing (step 192), and a scene
launch makes no transition sound. So launching Drop from a pad, at the end of a Rise
or after a fill, lands with no impact at all. Chris wants the crash available per
scene, saved, off by default and never automatic (NIGHT8_DECISIONS §7).

## Decision
A scene can be marked "Crash on launch". When a marked scene commits **during
playback**, by any path (pad launch, a Rise's landing, Fill → Drop), the track's
existing crash fires on the commit onset. A scene applied while stopped makes no
sound. A commit on the natural Drop crossing crashes once, not twice. Under a solo it
is silent, following the Night 3 rule that no transition sound starts while a stem is
soloed. The crash stays where ADR-008 put it, summed into the master outside the stems. Nothing turns it on except the user, per scene. The mark is
saved with the scene (format: ADR-023).

## Consequences
+ The user can mark a scene change with a crash, and ADR-008's default still holds:
  nothing makes a sound you didn't ask for.
+ It reuses the existing crash voice, so there's no new synth and no 9th stem
  (ADR-009).
- ADR-008 no longer has one rule. A launch can now make a transition sound, and the
  engine has to merge it with the natural crash.
- Every commit path (scene, build landing, linked fill) has to carry the accent, and
  any future commit path has to remember it too.
- It's a saved-format change, with ADR-023's cross-repo cost.

## Alternatives rejected
- Crash automatically when the Drop scene is launched: Chris ruled out anything
  automatic. A user's Drop isn't always a drop.
- One app-wide "crash on launch" toggle: a Drop and a Sparse want different answers,
  and Chris asked for it per scene.

Event 53 (`accent fired`) is protocol, not decision: it goes in the Night 8 protocol
doc.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: performers
relaunch the same scenes quickly (pad mashing, Compare A/B, going back and forth
between Drop and Build), and a marked scene crashes every time. That's the repeated
crash ADR-008 was written to avoid, now coming in through the launch path instead of
the loop.
Early warning sign to watch for: a request to rate-limit crashes or turn them off
everywhere, or a crash on relaunching a scene that's already active.
