/**
 * The scene strip: four scene pads after the stem mixer, then one toolbar row with the
 * shared timing selector, the one-bar Fill, Cancel (restores the mix from before scene
 * choices) and Compare A/B. The status line and the Shift+1–4 hint sit in the panel
 * header (`SceneHeader`), so they cost no rows of their own.
 *
 * A pad press only ever *launches*. Saving, renaming, duplicating and resetting live
 * in each pad's own menu, so a performance click can never overwrite a scene.
 *
 * What the pads show comes from the engine: a pad reads Active only after the engine
 * says the scene was applied. Until then it reads Sending…, then Queued · Bar N.
 *
 * Switch on → Rise (Night 7, a timed build) makes a pad press rise into its scene over
 * 2, 4 or 8 bars: the pad reads Rise · Bar N, then Rising · 2 of 4 with a progress rule along
 * its foot, then Active. Pressing it again while it waits or builds cancels, and the
 * mix glides back to where it started.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import type { Scene, SceneSlotId } from '../lib/contract';
import { SCENE_SLOTS } from '../lib/contract';
import {
  BUILD_BAR_CHOICES,
  isPending,
  isSceneSlot,
  sceneLevels,
  scenePreview,
  type BuildBars,
  type SceneRequest,
  type Timing,
} from '../lib/scenes';
import { STEM_ORDER, STEM_NAMES } from '../lib/stems';
import type { TrackSummary } from '../lib/types';
import { cx, Segmented } from './controls';
import type { CSSProperties, ReactNode } from 'react';

export type FillState = 'idle' | 'sending' | 'queued' | 'playing';

type Props = {
  scenes: Scene[];
  track: TrackSummary;
  /** The slot the engine last applied, or null. */
  active: SceneSlotId | null;
  /** The working mix differs from what the active scene applied. */
  modified: boolean;
  /** The latest scene request, pending or just settled. */
  request: SceneRequest | null;
  timing: Timing;
  /** Build mode's bar count, or null when a press switches on one onset. */
  buildBars: BuildBars | null;
  /** Why launching is unavailable right now (a mix is running), or null. */
  unavailable: string | null;
  /** The one-bar fill; left out until the engine has one. */
  fill?: FillState;
  fillBar?: number;
  fillName?: string;
  /** Why a fill cannot start now, or null. */
  fillUnavailable?: string | null;
  onTiming: (t: Timing | 'build') => void;
  onBuildBars: (bars: BuildBars) => void;
  onLaunch: (slot: SceneSlotId) => void;
  onCancel: () => void;
  onFill?: () => void;
  onCapture: (slot: SceneSlotId) => void;
  onRename: (slot: SceneSlotId, name: string) => boolean;
  onDuplicate: (from: SceneSlotId, to: SceneSlotId) => void;
  onReset: (slot: SceneSlotId) => void;
  /** Rendered at the end of the toolbar row (Compare A/B). */
  children?: ReactNode;
};

export function SceneStrip(props: Props) {
  const { scenes, active, modified, request, timing, buildBars, unavailable } = props;
  const pending = isPending(request) && isSceneSlot(request.target) ? request : null;
  const [menuFor, setMenuFor] = useState<SceneSlotId | null>(null);

  return (
    <section className="scene-strip" aria-label="Scenes">
      <div className="scene-pads">
        {SCENE_SLOTS.map((slot, i) => {
          const scene = scenes.find((s) => s.slot === slot)!;
          const preview = scenePreview(scene, props.track);
          const isActive = active === slot;
          const queued = pending?.target === slot ? pending : null;
          const state = unavailable
            ? 'unavailable'
            : queued
              ? queued.status === 'sending'
                ? 'sending'
                : queued.status === 'building'
                  ? 'building'
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
                  ? queuedLine(queued!)
                  : state === 'building'
                    ? buildingLine(queued!)
                    : state === 'modified'
                      ? 'Active · Modified'
                      : state === 'active'
                        ? 'Active'
                        : '';
          return (
            <div
              key={slot}
              className="scene-slot"
              data-state={state}
              data-build={queued?.build?.bars}
              style={
                state === 'building' && queued?.build
                  ? ({ '--build-progress': (queued.build.bar ?? 1) / queued.build.bars } as CSSProperties)
                  : undefined
              }
            >
              <button
                type="button"
                className="scene-pad tap"
                disabled={state === 'unavailable'}
                aria-label={
                  queued
                    ? `Cancel ${queued.build ? 'the rise into' : 'the queued'} ${scene.name}`
                    : buildBars !== null
                      ? `Rise into ${scene.name} over ${buildBars} bars`
                      : `Launch ${scene.name}`
                }
                aria-pressed={isActive}
                aria-keyshortcuts={`Shift+${i + 1}`}
                aria-describedby={`scene-summary-${slot} scene-line-${slot}`}
                title={`${preview.description} · Shift+${i + 1}`}
                onClick={() => props.onLaunch(slot)}
              >
                <span className="scene-name">{scene.name}</span>
                <span id={`scene-summary-${slot}`} className="scene-summary">{preview.summary}</span>
                <span className="scene-pad-foot">
                  <span className="scene-mix-preview" aria-hidden="true">
                    {sceneLevels(scene).map((level, index) => (
                      <span
                        key={STEM_ORDER[index]}
                        className="scene-mix-track"
                        title={`${STEM_NAMES[STEM_ORDER[index]!]}: ${level > 0 ? `${Math.round(level * 100)}%` : 'off'}`}
                      >
                        <span className="scene-mix-level" style={{ transform: `scaleY(${level})` }} />
                      </span>
                    ))}
                  </span>
                  <span id={`scene-line-${slot}`} className="scene-line">
                    {line || ' '}
                  </span>
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
                  description={preview.description}
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
      <div className="scene-toolbar">
        <Segmented<Timing | 'build'>
          label="Switch on"
          value={buildBars !== null ? 'build' : timing}
          onPick={props.onTiming}
          options={[
            { value: 'now', label: 'Now', aria: 'Launch now' },
            { value: 'beat', label: 'Next beat', short: 'Beat', aria: 'Launch on the next beat' },
            { value: 'bar', label: 'Next bar', short: 'Bar', aria: 'Launch on the next bar' },
            { value: 'build', label: 'Rise', aria: 'Rise into the scene over several bars' },
          ]}
        />
        {buildBars !== null ? (
          <div className="scene-build-bars">
            <Segmented<BuildBars>
              label="Rise over"
              hideLabel
              value={buildBars}
              onPick={props.onBuildBars}
              options={BUILD_BAR_CHOICES.map((n) => ({ value: n, label: `${n}`, aria: `Rise over ${n} bars` }))}
            />
            <span className="scene-build-unit" aria-hidden="true">bars</span>
          </div>
        ) : null}
        <div className="scene-strip-actions">
          {props.onFill ? <FillButton {...props} /> : null}
          <button
            type="button"
            className="text-button scene-cancel"
            disabled={Boolean(unavailable) || (!pending && active === null)}
            onClick={props.onCancel}
            aria-label="Cancel scene"
            title={unavailable ?? (pending || active !== null ? 'Clear the scene and restore your previous mix' : 'No scene selected')}
          >
            <X size={12} aria-hidden="true" /> Cancel
          </button>
        </div>
        {props.children}
      </div>
    </section>
  );
}

/**
 * The scene panel's header extras: the last outcome as a status line and the
 * Shift+1–4 hint as a small tag. Rendered as the panel's header actions, so the
 * status needs no row of its own.
 */
export function SceneHeader({ status }: { status: string }) {
  return (
    <>
      {/* Discrete changes only ("Drop queued", "Drop active"), never every beat. */}
      <p className="scene-status" role="status" aria-live="polite" title={status || undefined}>
        {status}
      </p>
      <span className="scene-keys" title="Shift+1 to Shift+4 launch the four scenes">
        <kbd>Shift</kbd> <kbd>1–4</kbd>
      </span>
    </>
  );
}

function queuedLine(r: SceneRequest): string {
  if (r.build) return r.bar ? `Rise · Bar ${r.bar}` : 'Rise queued';
  if (r.timing === 'now') return 'Queued · now';
  return r.bar ? `Queued · Bar ${r.bar}` : 'Queued';
}

function buildingLine(r: SceneRequest): string {
  const b = r.build!;
  return `Rising · ${b.bar ?? 1} of ${b.bars}`;
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
          : 'Drum fill';
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
  description,
  onClose,
  onCapture,
  onRename,
  onDuplicate,
  onReset,
}: {
  scene: Scene;
  scenes: Scene[];
  description: string;
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

  // Focus moves into the menu once, when it opens. This used to share an effect with
  // the outside-click listener below, keyed on `onClose`; the parent hands over a new
  // `onClose` whenever it re-renders (the playhead does that several times a second),
  // so focus was pulled back to the first button at random, sometimes straight out of
  // the Rename field.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
  }, []);

  // Escape or a click outside closes it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

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
      <p className="scene-menu-desc">{description}</p>
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
            // The Rename button this replaces had focus; without this it falls to the
            // page and Escape no longer reaches the menu.
            autoFocus
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
