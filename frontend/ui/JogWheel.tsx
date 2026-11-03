/**
 * The jog wheel. Moved from app.tsx unchanged in behavior.
 */

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { engine } from '../lib/engine';
import { cx } from './controls';

/** Degrees of backward wind, within one drag, that throw a backspin. */
const JOG_BACKSPIN_DEG = 80;
/** A backward flick faster than this (deg/ms) backspins on release regardless of distance. */
const JOG_FLICK_SPEED = 0.6;
/** How long the hand can rest without moving before a bend falls back to the touch drag. */
const JOG_REST_MS = 90;
/** Per-frame (60 Hz) decay of the disc's coast after release. */
const JOG_FRICTION = 0.92;

/**
 * The jog wheel: a platter you put your hand on.
 *
 * Any touch does something. Putting a hand on the platter drags the tempo down, the
 * way fingers on a spinning record slow it; moving forward bends it up, moving back
 * bends it down, and a hand resting still drags again. Wind it back a quarter turn,
 * or flick it back, and it throws a backspin. The wheel only decides the gesture —
 * the audio is the engine's.
 *
 * Let go mid-spin and the disc coasts to a stop. That coast is visual only; the tempo
 * returns to nominal the moment the hand leaves.
 *
 * While the deck plays the label turns at 33⅓ rpm, so the wheel reads as live. That
 * idle spin is decoration and stops under reduced motion; the drag rotation is the
 * control itself and doesn't.
 */
export function JogWheel({ spinning }: { spinning: boolean }) {
  const discRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    lastAngle: number;
    wound: number;
    lastTime: number;
    speed: number;
    fired: boolean;
    dir: -1 | 0 | 1;
  } | null>(null);
  const turn = useRef(0);
  const rest = useRef<number | undefined>(undefined);
  const coast = useRef<number | undefined>(undefined);
  const [held, setHeld] = useState(false);

  useEffect(
    () => () => {
      window.clearTimeout(rest.current);
      if (coast.current !== undefined) cancelAnimationFrame(coast.current);
    },
    [],
  );

  const angleOf = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (box.left + box.width / 2);
    const y = event.clientY - (box.top + box.height / 2);
    return (Math.atan2(y, x) * 180) / Math.PI;
  };

  const paint = () => discRef.current?.style.setProperty('--turn', `${turn.current}deg`);

  const bend = (dir: -1 | 0 | 1) => {
    const d = drag.current;
    if (!d || d.dir === dir) return;
    d.dir = dir;
    engine.nudge(dir);
  };

  const stopCoast = () => {
    if (coast.current !== undefined) cancelAnimationFrame(coast.current);
    coast.current = undefined;
  };

  /** Let the disc run on at the release speed (deg/ms), decaying per frame. */
  const startCoast = (speed: number) => {
    let v = speed;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      turn.current += v * dt;
      paint();
      // Friction per frame, scaled to the frame's length, so it settles the same at
      // 60 Hz and 120 Hz.
      v *= JOG_FRICTION ** (dt / 16.7);
      coast.current = Math.abs(v) > 0.005 ? requestAnimationFrame(step) : undefined;
    };
    coast.current = requestAnimationFrame(step);
  };

  const release = () => {
    const d = drag.current;
    if (!d) return;
    window.clearTimeout(rest.current);
    if (!d.fired && d.speed < -JOG_FLICK_SPEED) engine.backspin();
    engine.nudge(0);
    if (Math.abs(d.speed) > 0.02) startCoast(d.speed);
    drag.current = null;
    setHeld(false);
  };

  return (
    <div className="jog-wrap">
      <div
        role="button"
        tabIndex={0}
        data-own-space=""
        aria-label="Jog wheel. Touch to drag the tempo, turn it to bend, wind it back to backspin. Arrow keys bend, space backspins."
        className={cx('jog', held && 'is-held')}
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* pointer already released */
          }
          stopCoast();
          drag.current = {
            lastAngle: angleOf(event),
            wound: 0,
            lastTime: event.timeStamp,
            speed: 0,
            fired: false,
            dir: 0,
          };
          // A hand on the platter drags it, so even a tap is heard.
          bend(-1);
          setHeld(true);
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const angle = angleOf(event);
          // Wrap into ±180 so crossing nine o'clock doesn't read as a whole turn.
          let delta = angle - d.lastAngle;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          const dt = Math.max(1, event.timeStamp - d.lastTime);
          d.lastAngle = angle;
          d.lastTime = event.timeStamp;
          // Smoothed, so one jittery sample can't fake a flick.
          d.speed = 0.6 * (delta / dt) + 0.4 * d.speed;
          turn.current += delta;
          paint();

          if (Math.abs(delta) < 0.05) return;
          // Reversing direction starts a fresh wind, so a scrub back and forth never
          // adds up to a backspin by accident.
          d.wound = Math.sign(delta) === Math.sign(d.wound) ? d.wound + delta : delta;
          bend(delta > 0 ? 1 : -1);
          window.clearTimeout(rest.current);
          rest.current = window.setTimeout(() => {
            if (drag.current) drag.current.speed = 0;
            bend(-1);
          }, JOG_REST_MS);
          if (!d.fired && d.wound < -JOG_BACKSPIN_DEG) {
            d.fired = true;
            engine.backspin();
          }
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            if (event.repeat) return;
            turn.current -= 180;
            paint();
            engine.backspin();
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            turn.current += 15;
            paint();
            engine.nudge(1);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            turn.current -= 15;
            paint();
            engine.nudge(-1);
          }
        }}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow')) engine.nudge(0);
        }}
      >
        <div ref={discRef} className="jog-disc">
          <div className={cx('jog-label', spinning && !held && 'is-spinning')}>
            <span className="jog-marker" />
          </div>
        </div>
      </div>
      <span className="jog-caption">Wind back to backspin</span>
    </div>
  );
}
