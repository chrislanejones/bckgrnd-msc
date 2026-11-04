/**
 * The scene strip: four scene pads above the stem mixer, one shared timing selector,
 * the one-bar Fill, and Cancel Queued.
 *
 * A pad press only ever *launches*. Saving, renaming, duplicating and resetting live
 * in each pad's own menu, so a performance click can never overwrite a scene.
 *
 * What the pads show comes from the engine: a pad reads Active only after the engine
 * says the scene was applied. Until then it reads Sending…, then Queued · Bar N.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import type { Scene, SceneSlotId } from '../lib/contract';
import { SCENE_SLOTS } from '../lib/contract';
import { isPending, isSceneSlot, sceneDescription, type SceneRequest, type Timing } from '../lib/scenes';
import { cx, Segmented } from './controls';
import type { ReactNode } from 'react';

export type FillState = 'idle' | 'sending' | 'queued' | 'playing';

type Props = {
  scenes: Scene[];
  /** The slot the engine last applied, or null. */
  active: SceneSlotId | null;
  /** The working mix differs from what the active scene applied. */
  modified: boolean;
  /** The latest scene request, pending or just settled. */
  request: SceneRequest | null;
  timing: Timing;
  /** Why launching is unavailable right now (a mix is running), or null. */
  unavailable: string | null;
  /** A short line about the last outcome, e.g. "Drop already applied". */
  status: string;
  /** The one-bar fill; left out until the engine has one. */
  fill?: FillState;
  fillBar?: number;
  fillName?: string;
  /** Why a fill cannot start now, or null. */
  fillUnavailable?: string | null;
  onTiming: (t: Timing) => void;
  onLaunch: (slot: SceneSlotId) => void;
  onCancel: () => void;
  onFill?: () => void;
  onCapture: (slot: SceneSlotId) => void;
  onRename: (slot: SceneSlotId, name: string) => boolean;
  onDuplicate: (from: SceneSlotId, to: SceneSlotId) => void;
  onReset: (slot: SceneSlotId) => void;
  /** Rendered under the pads (Compare A/B). */
  children?: ReactNode;
};

export function SceneStrip(props: Props) {
  const { scenes, active, modified, request, timing, unavailable, status } = props;
  const pending = isPending(request) && isSceneSlot(request.target) ? request : null;
  const [menuFor, setMenuFor] = useState<SceneSlotId | null>(null);

  return (
    <section className="scene-strip" aria-label="Scenes">
      <div className="scene-strip-head">
        <Segmented<Timing>
          label="Launch at"
          value={timing}
          onPick={props.onTiming}
          options={[
            { value: 'now', label: 'Now', aria: 'Launch now' },
            { value: 'beat', label: 'Beat', aria: 'Launch on the next beat' },
            { value: 'bar', label: 'Bar', aria: 'Launch on the next bar' },
          ]}
        />
        <div className="scene-strip-actions">
          {props.onFill ? <FillButton {...props} /> : null}
          <button
            type="button"
            className="text-button"
            disabled={!pending}
            onClick={props.onCancel}
            aria-label={pending ? `Cancel queued ${sceneName(scenes, pending.target)}` : 'Cancel queued scene'}
          >
            Cancel queued
          </button>
        </div>
      </div>

      <div className="scene-pads">
        {SCENE_SLOTS.map((slot, i) => {
          const scene = scenes.find((s) => s.slot === slot)!;
          const isActive = active === slot;
          const isQueued = pending?.target === slot;
          const state = unavailable
            ? 'unavailable'
            : isQueued
              ? pending.status === 'sending'
                ? 'sending'
                : 'queued'
              : isActive
                ? modified
                  ? 'modified'
                  : 'active'
                : 'available';
          const line =
            state === 'unavailable'
              ? unavailable
              : state === 'sending'
                ? 'Sending…'
                : state === 'queued'
                  ? queuedLine(pending!)
                  : state === 'modified'
                    ? 'Active · Modified'
                    : state === 'active'
                      ? 'Active'
                      : '';
          return (
            <div key={slot} className="scene-slot" data-state={state}>
              <button
                type="button"
                className="scene-pad tap"
                disabled={state === 'unavailable'}
                aria-keyshortcuts={`Shift+${i + 1}`}
                aria-describedby={`scene-line-${slot}`}
                onClick={() => props.onLaunch(slot)}
              >
                <span className="scene-name">{scene.name}</span>
                <span id={`scene-line-${slot}`} className="scene-line">
                  {line || ' '}
                </span>
              </button>
              <button
                type="button"
                className="scene-menu-button"
                aria-label={`${scene.name} options`}
                aria-expanded={menuFor === slot}
                aria-haspopup="dialog"
                onClick={() => setMenuFor((m) => (m === slot ? null : slot))}
              >
                <MoreHorizontal aria-hidden="true" size={14} />
              </button>
              {menuFor === slot ? (
                <SceneMenu
                  scene={scene}
                  scenes={scenes}
                  onClose={() => setMenuFor(null)}
                  onCapture={() => {
                    props.onCapture(slot);
                    setMenuFor(null);
                  }}
                  onRename={(name) => props.onRename(slot, name)}
                  onDuplicate={(to) => {
                    props.onDuplicate(slot, to);
                    setMenuFor(null);
                  }}
                  onReset={() => {
                    props.onReset(slot);
                    setMenuFor(null);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {props.children}
      {/* Discrete changes only ("Drop queued", "Drop active"), never every beat. */}
      <p className="scene-status" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}

function sceneName(scenes: Scene[], target: string): string {
  return scenes.find((s) => s.slot === target)?.name ?? target;
}

function queuedLine(r: SceneRequest): string {
  if (r.timing === 'now') return 'Queued · now';
  return r.bar ? `Queued · Bar ${r.bar}` : 'Queued';
}

function FillButton(props: Props) {
  const { fill = 'idle', fillBar, fillName = 'Fill', fillUnavailable = null } = props;
  const label =
    fill === 'playing'
      ? 'Fill playing'
      : fill === 'queued'
        ? fillBar
          ? `Fill · Bar ${fillBar}`
          : 'Fill queued'
        : fill === 'sending'
          ? 'Fill…'
          : 'Fill';
  const aria =
    fill === 'playing'
      ? `${fillName} is playing`
      : fill === 'queued' || fill === 'sending'
        ? `Cancel the queued ${fillName}`
        : `${fillName} for one bar, from the next bar`;
  return (
    <button
      type="button"
      className={cx('fill-button tap', fill !== 'idle' && 'is-on')}
      data-state={fill}
      disabled={fill === 'playing' || (fill === 'idle' && fillUnavailable !== null)}
      aria-label={aria}
      title={fill === 'idle' && fillUnavailable ? fillUnavailable : `${fillName}: one bar, from the next bar`}
      onClick={props.onFill}
    >
      {label}
    </button>
  );
}

function SceneMenu({
  scene,
  scenes,
  onClose,
  onCapture,
  onRename,
  onDuplicate,
  onReset,
}: {
  scene: Scene;
  scenes: Scene[];
  onClose: () => void;
  onCapture: () => void;
  onRename: (name: string) => boolean;
  onDuplicate: (to: SceneSlotId) => void;
  onReset: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState(scene.name);
  const [invalid, setInvalid] = useState(false);

  // Focus moves into the menu; Escape or a click outside closes it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="scene-menu"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="scene-menu-head">
        <p id={titleId} className="scene-menu-title">
          {scene.name}
        </p>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      <p className="scene-menu-desc">{sceneDescription(scene)}</p>
      <button type="button" className="scene-menu-item" onClick={onCapture}>
        Capture current mix
      </button>
      {naming ? (
        <form
          className="scene-rename"
          onSubmit={(e) => {
            e.preventDefault();
            if (onRename(draft)) {
              setNaming(false);
              onClose();
            } else {
              setInvalid(true);
            }
          }}
        >
          <label className="sr-only" htmlFor={`${titleId}-name`}>
            Scene name
          </label>
          <input
            id={`${titleId}-name`}
            className="scene-rename-input"
            value={draft}
            maxLength={40}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
          />
          <button type="submit" className="scene-menu-item">
            Save name
          </button>
        </form>
      ) : (
        <button type="button" className="scene-menu-item" onClick={() => setNaming(true)}>
          Rename…
        </button>
      )}
      <p className="scene-menu-group">Duplicate to</p>
      <div className="scene-menu-row">
        {scenes
          .filter((s) => s.slot !== scene.slot)
          .map((s) => (
            <button
              key={s.slot}
              type="button"
              className="scene-menu-chip"
              aria-label={`Duplicate ${scene.name} into the ${s.name} slot`}
              onClick={() => onDuplicate(s.slot)}
            >
              {s.name}
            </button>
          ))}
      </div>
      <button type="button" className="scene-menu-item" onClick={onReset}>
        Reset to factory
      </button>
    </div>
  );
}
