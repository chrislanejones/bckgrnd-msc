# Product

This context records the existing product decisions in [the README](../README.md)
and [Design philosophy](DESIGN_PHILOSOPHY.md). Those documents remain the source
of truth for the instrument and its visual system.

## Register

product

## Users

People playing and reshaping an instrumental in a browser or desktop webview.
They should be able to press Play and change the mix immediately, including on
a phone, without learning the detailed controls first.

## Product Purpose

An instrument with eighteen tracks and eight independently controllable sounds
per track. Users change the balance, remove sounds, compare mixes, launch scenes,
and open detailed sound or pattern controls when needed.

## Brand Personality

Musical, tactile, clear. Preserve the established dark surfaces and acid-green
identity. Feedback explains what is playing, what can change, and what happens
next. The interface supports listening and performing.

## Anti-references

Avoid ornamental equipment styling, excessive gloss, fake screws, decorative
animation, a different decorative color for every sound, and detailed controls
exposed simply because space is available. Never leave silence unexplained.

## Design Principles

- Music first: orient the listener to the track, song part, and sounding layers.
- Tactile controls: make interaction apparent through familiar affordances.
- Progressive complexity: put immediate musical actions before detailed editing.
- Visible cause and effect: explain state with words as well as color.
- Preserve the engine boundary: React presents state and sends intent.

## Accessibility & Inclusion

Support keyboard operation with visible focus, touch targets of at least 44 px
(secondary badges may be smaller), reduced motion, and a usable layout at 375 px
without page-level horizontal scrolling. Use native range inputs for sliders and
explain why a control is disabled. State must never rely on color alone.
