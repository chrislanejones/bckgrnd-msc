/**
 * The scene strip: four scene pads after the stem mixer, then the toolbar: the shared
 * timing selector and Cancel (restores the mix from before scene choices), the fill
 * row, and Compare A/B, a row each. The status line and the Shift+1–4 hint sit in the
 * panel header (`SceneHeader`), so they cost no rows of their own.
 *
 * A pad press only ever *launches*. Saving, renaming, duplicating, resetting and Crash
 * on launch live in each pad's own menu, so a performance click can never overwrite a
 * scene. A pad whose scene crashes on launch says so in words beside a bolt icon.
 *
 * What the pads show comes from the engine: a pad reads Active only after the engine
 * says the scene was applied. Until then it reads Sending…, then Queued · Bar N.
 *
 * Switch on → Rise (Night 7, a timed build) makes a pad press rise into its scene over
 * 2, 4 or 8 bars: the pad reads Rise · Bar N, then Rising · 2 of 4 with a progress rule along
 * its foot, then Active. Pressing it again while it waits or builds cancels, and the
 * mix glides back to where it started. Finish with Fill (Night 8) ends the Rise with the
 * track's fill on its last bar: the pad reads Filling into Drop for that bar.
 *
 * Fill (Night 8) has a row of its own under Switch on: Fill at (Next bar or Phrase end,
 * with a 2 · 4 · 8 · 16 bars picker for Phrase end), the Fill button, and Fill → Drop, which
 * plays the fill and lands the fourth scene on the onset it ends: the pad reads Fill in ·
 * Bar 9, then Filling into Drop, then Active.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, MoreHorizontal, X, Zap } from 'lucide-react';
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
import {
  FILL_STYLES,
  FILL_STYLE_HINT,
  FILL_STYLE_LABEL,
  PHRASE_BAR_CHOICES,
  fillButtonAria,
  fillButtonJob,
  fillButtonLabel,
  fillButtonTitle,
  fillInLine,
  fillIntoAria,
  fillIntoJob,
  fillIntoLabel,
  fillPhrase,
  fillingLine,
  type FillAt,
  type FillJob,
  type FillStyle,
  type PhraseBars,
} from '../lib/fills';
import { STEM_ORDER, STEM_NAMES } from '../lib/stems';
import type { TrackSummary } from '../lib/types';
import { cx, Segmented } from './controls';
import type { CSSProperties, ReactNode } from 'react';

/** Fill, Fill at, Fill → Drop and Finish with Fill; left out when the track has no fill. */
export type FillControls = {
  /** The fill the engine holds (plain, a Fill into's or a Rise's), or null. */
  job: FillJob | null;
  /** The fill's name for its buttons: its style's ("Classic fill"). */
  name: string;
  at: FillAt;
  phraseBars: PhraseBars;
  /** Finish with Fill, on Rise. */
  riseFill: boolean;
  /** Why Fill cannot start now, or null. */
  unavailable: string | null;
  /** The scene Fill → Drop lands, by its current name. */
  intoName: string;
  /** Why Fill → Drop cannot start now, or null. */
  intoUnavailable: string | null;
  onFill: () => void;
  onFillInto: () => void;
  onAt: (at: FillAt) => void;
  onPhraseBars: (bars: PhraseBars) => void;
  onRiseFill: (on: boolean) => void;
};

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
  /** The fill controls; left out until the track has a fill. */
  fill?: FillControls;
  onTiming: (t: Timing | 'build') => void;
  onBuildBars: (bars: BuildBars) => void;
  onLaunch: (slot: SceneSlotId) => void;
  onCancel: () => void;
  onCapture: (slot: SceneSlotId) => void;
  onRename: (slot: SceneSlotId, name: string) => boolean;
  onDuplicate: (from: SceneSlotId, to: SceneSlotId) => void;
  onReset: (slot: SceneSlotId) => void;
  /** Crash on launch for one slot (project version 4). */
  onCrash: (slot: SceneSlotId, crash: boolean) => void;
  /**
   * A press on an unavailable fill button, with its reason: shown in the status line,
   * so a touch user, who gets no tooltip, sees why (`useSceneNotice`).
   */
  onUnavailable?: (reason: string) => void;
  /** Rendered at the end of the toolbar, a row of its own (Compare A/B, when unfolded). */
  children?: ReactNode;
};

export function SceneStrip(props: Props) {
  const { scenes, active, modified, request, timing, buildBars, unavailable, fill } = props;
  const riseFill = Boolean(fill?.riseFill);
  const pending = isPending(request) && isSceneSlot(request.target) ? request : null;
  const [menuFor, setMenuFor] = useState<SceneSlotId | null>(null);
  const reasonIds = { fill: useId(), into: useId() };

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
                  ? queuedLine(queued!, scene.name)
                  : state === 'building'
                    ? buildingLine(queued!, scene.name)
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
                    ? `Cancel ${queued.build ? 'the rise into' : queued.fillInto ? 'Fill into' : 'the queued'} ${scene.name}`
                    : buildBars !== null
                      ? `Rise into ${scene.name} over ${buildBars} bars${riseFill ? ', ending with a fill' : ''}`
                      : `Launch ${scene.name}`
                }
                aria-pressed={isActive}
                aria-keyshortcuts={`Shift+${i + 1}`}
                aria-describedby={`scene-summary-${slot} scene-line-${slot}`}
                data-crash={scene.crash ? 'on' : undefined}
                title={`${preview.description} · Shift+${i + 1}`}
                onClick={() => props.onLaunch(slot)}
              >
                <span className="scene-name">{scene.name}</span>
                <span id={`scene-summary-${slot}`} className="scene-summary">
                  {scene.crash ? (
                    <>
                      <span className="scene-crash-mark">
                        <Zap aria-hidden="true" size={11} strokeWidth={2.5} />
                        Crash<span className="sr-only"> on launch</span>
                      </span>
                      <span className="scene-crash-sep" aria-hidden="true">·</span>
                      <span className="sr-only">, </span>
                    </>
                  ) : null}
                  {preview.summary}
                </span>
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
                  onCrash={(on) => props.onCrash(slot, on)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="scene-toolbar">
        <Segmented<Timing | 'build'>
          radio
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
          <>
            <div className="scene-build-bars">
              <Segmented<BuildBars>
                radio
                label="Rise over"
                hideLabel
                value={buildBars}
                onPick={props.onBuildBars}
                options={BUILD_BAR_CHOICES.map((n) => ({ value: n, label: `${n}`, aria: `Rise over ${n} bars` }))}
              />
              <span className="scene-build-unit" aria-hidden="true">bars</span>
            </div>
            {fill ? <RiseFillToggle fill={fill} /> : null}
          </>
        ) : null}
        <div className="scene-strip-actions">
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
        {fill ? <FillTools fill={fill} ids={reasonIds} onUnavailable={props.onUnavailable} /> : null}
        {props.children}
      </div>
      {fill ? <FillReasons fill={fill} ids={reasonIds} /> : null}
    </section>
  );
}

/**
 * The scene panel's header extras: the last outcome as a status line, the Fill style
 * menu and the Shift+1–4 hint as a small tag. Rendered as the panel's header actions, so the
 * status needs no row of its own.
 */
export function SceneHeader({
  status,
  fillStyle,
  compare,
}: {
  status: string;
  /** Fill style, when the track has fills: the choice and how to change it. */
  fillStyle?: { style: FillStyle; onStyle: (style: FillStyle) => void };
  /** Compare A/B's fold: the toggle sits here, the row it opens ends the toolbar. */
  compare?: CompareFold;
}) {
  return (
    <>
      {/* Discrete changes only ("Drop queued", "Drop active"), never every beat. */}
      <p className="scene-status" role="status" aria-live="polite" title={status || undefined}>
        {status}
      </p>
      {fillStyle ? <FillStyleSelect {...fillStyle} /> : null}
      {compare ? <CompareToggle {...compare} /> : null}
      <span className="scene-keys" title="Shift+1 to Shift+4 launch the four scenes">
        <kbd>Shift</kbd> <kbd>1–4</kbd>
      </span>
    </>
  );
}

/** Compare A/B's fold, as the header toggle needs it. */
export type CompareFold = {
  /** The row is showing: unfolded, or a capture exists. */
  shown: boolean;
  /** A capture exists, so the row stays until Keep current or Exit comparison. */
  comparing: boolean;
  /** The id of the row it shows. */
  controls: string;
  onToggle: () => void;
  onUnavailable: (reason: string) => void;
};

/** Why the fold can't close: a comparison is under way and its state must stay in view. */
const COMPARE_HELD = 'Compare A/B stays open while comparing: Keep current or Exit comparison';

/**
 * Compare A/B's fold toggle (Night 9B), in the panel header beside Fill style. Folded by
 * default and remembered per viewer; a capture holds the row open, so which mix is
 * playing (A · Listening, B · Modified) is never out of sight during a comparison.
 * "Compare A/B" on a wide panel, "A/B" on a narrow one; the name is always the full one.
 */
function CompareToggle({ shown, comparing, controls, onToggle, onUnavailable }: CompareFold) {
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        className="compare-toggle tap"
        aria-expanded={shown}
        aria-controls={shown ? controls : undefined}
        aria-disabled={comparing || undefined}
        aria-describedby={comparing ? reasonId : undefined}
        aria-label="Compare A/B"
        title={comparing ? COMPARE_HELD : shown ? 'Fold Compare A/B' : 'Compare two mix snapshots'}
        onClick={comparing ? () => onUnavailable(COMPARE_HELD) : onToggle}
      >
        <ChevronRight className="compare-toggle-chevron" aria-hidden="true" size={12} strokeWidth={2.5} />
        <span className="compare-toggle-full" aria-hidden="true">Compare A/B</span>
        <span className="compare-toggle-short" aria-hidden="true">A/B</span>
      </button>
      {comparing ? (
        <span id={reasonId} hidden>
          {COMPARE_HELD}
        </span>
      ) : null}
    </>
  );
}

/**
 * The scenes status line with a short-lived notice over it: the reason an unavailable
 * control can't be pressed, said where the panel already reports what happened. It
 * gives way to the next real status, or after a few seconds.
 */
export function useSceneNotice(status: string): [string, (text: string) => void] {
  const [notice, setNotice] = useState<{ text: string; over: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);
  const notify = useCallback((text: string) => setNotice({ text, over: status }), [status]);
  return [notice && notice.over === status ? notice.text : status, notify];
}

function queuedLine(r: SceneRequest, name: string): string {
  if (r.build) return r.bar ? `Rise · Bar ${r.bar}` : 'Rise queued';
  if (r.fillInto) return r.fillInto.filling ? fillingLine(name) : fillInLine(r.bar);
  if (r.timing === 'now') return 'Queued · now';
  return r.bar ? `Queued · Bar ${r.bar}` : 'Queued';
}

function buildingLine(r: SceneRequest, name: string): string {
  const b = r.build!;
  if (b.fill?.filling) return fillingLine(name);
  return `Rising · ${b.bar ?? 1} of ${b.bars}`;
}

/**
 * Finish with Fill, beside Rise's bars: one pill, filled acid when on. "+ Fill" on a
 * narrow panel; its name stays the full one.
 */
function RiseFillToggle({ fill }: { fill: FillControls }) {
  return (
    <div className="segmented scene-rise-fill">
      <button
        type="button"
        role="switch"
        className="segment tap"
        aria-checked={fill.riseFill}
        aria-label="Finish with Fill: the fill plays the Rise's last bar"
        title="Finish with Fill: the fill plays the Rise's last bar, and the scene lands on the next downbeat"
        onClick={() => fill.onRiseFill(!fill.riseFill)}
      >
        <span className="rise-fill-full">Finish with Fill</span>
        <span className="rise-fill-short" aria-hidden="true">+ Fill</span>
      </button>
    </div>
  );
}

/** Why the Fill button can't be pressed now, when it is waiting to be (not while playing). */
const fillReason = (fill: FillControls): string | null => (fillButtonJob(fill.job) ? null : fill.unavailable);
/** Why Fill → Drop can't be pressed now; never while it is its own to cancel. */
const fillIntoReason = (fill: FillControls): string | null => (fillIntoJob(fill.job) ? null : fill.intoUnavailable);

/**
 * The fill buttons' reasons, outside the toolbar so they take no room and stay out of
 * the buttons' own words: hidden, and read as each button's description.
 */
function FillReasons({ fill, ids }: { fill: FillControls; ids: { fill: string; into: string } }) {
  const a = fillReason(fill);
  const b = fillIntoReason(fill);
  return (
    <>
      {a ? <span id={ids.fill} hidden>Unavailable: {a}</span> : null}
      {b ? <span id={ids.into} hidden>Unavailable: {b}</span> : null}
    </>
  );
}

/** Fill's own row: Fill at, the phrase length (Phrase end only), Fill and Fill → Drop. */
function FillTools({
  fill,
  ids,
  onUnavailable,
}: {
  fill: FillControls;
  ids: { fill: string; into: string };
  onUnavailable?: (reason: string) => void;
}) {
  return (
    <div className="scene-fill-tools" role="group" aria-label="Fill">
      <Segmented<FillAt>
        radio
        label="Fill at"
        value={fill.at}
        onPick={fill.onAt}
        options={[
          { value: 'bar', label: 'Next bar', short: 'Bar', aria: 'Fill on the next bar' },
          { value: 'phrase', label: 'Phrase end', short: 'Phrase', aria: 'Fill at the phrase end' },
        ]}
      />
      {fill.at === 'phrase' ? (
        <div className="scene-phrase-bars">
          <Segmented<PhraseBars>
            radio
            label="Phrase length"
            hideLabel
            value={fill.phraseBars}
            onPick={fill.onPhraseBars}
            options={PHRASE_BAR_CHOICES.map((n) => ({ value: n, label: `${n}`, aria: `Phrases of ${n} bars` }))}
          />
          <span className="scene-build-unit" aria-hidden="true">bars</span>
        </div>
      ) : null}
      <FillButton fill={fill} reasonId={ids.fill} onUnavailable={onUnavailable} />
      <FillIntoButton fill={fill} reasonId={ids.into} onUnavailable={onUnavailable} />
    </div>
  );
}

/**
 * Fill style (Night 9): a compact menu of the four, Classic first. A native select, so
 * keyboard, touch and screen readers get the platform's own picker; its name is "Fill
 * style" and its tooltip says what the chosen one does. A fill already queued keeps
 * the style it was sent with.
 *
 * It sits in the panel's header, not on the fill row: with Phrase end, 16 bars and the
 * widest button words ("Fill · Next phrase → Drop") that row is already full at every
 * mouse width from 900 to 1280px, and a second fill row would break the toolbar's
 * three 32px rows (tools/verify-ui-fills.mjs).
 */
function FillStyleSelect({ style, onStyle }: { style: FillStyle; onStyle: (style: FillStyle) => void }) {
  return (
    <label className="scene-fill-style" title={`Fill style: ${FILL_STYLE_LABEL[style]}, ${FILL_STYLE_HINT[style]}`}>
      <span className="control-label">Fill style</span>
      <select
        className="fill-style-select"
        value={style}
        onChange={(event) => onStyle(event.target.value as FillStyle)}
      >
        {FILL_STYLES.map((style) => (
          <option key={style} value={style}>
            {FILL_STYLE_LABEL[style]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The Fill button: the track's fill in the chosen style, at the Fill at timing. Shows where a queued fill
 * plays ("Fill · Bar 8", "Fill · Next phrase") and any fill playing.
 *
 * Unavailable is aria-disabled, not disabled: it stays in the tab order, so focus is
 * not dropped to the page when a queued fill starts playing under it, and the reason
 * (a Rise ending with the fill, say) is read as its description.
 */
function FillButton({
  fill,
  reasonId,
  onUnavailable,
}: {
  fill: FillControls;
  reasonId: string;
  onUnavailable?: (reason: string) => void;
}) {
  const own = fillButtonJob(fill.job);
  const state = own ? own.status : 'idle';
  const phrase = fillPhrase(fill.at, fill.phraseBars);
  const off = state === 'playing' || (state === 'idle' && fill.unavailable !== null);
  const reason = fillReason(fill);
  return (
    <button
      type="button"
      className={cx('fill-button tap', state !== 'idle' && 'is-on')}
      data-state={state}
      aria-disabled={off || undefined}
      aria-label={fillButtonAria(fill.job, fill.name, phrase)}
      aria-describedby={reason ? reasonId : undefined}
      title={reason ?? fillButtonTitle(fill.name, own ? own.phrase : phrase)}
      onClick={off ? (reason && onUnavailable ? () => onUnavailable(`Fill: ${reason}`) : undefined) : fill.onFill}
    >
      {fillButtonLabel(fill.job)}
    </button>
  );
}

/**
 * Fill → Drop: the fill, then the fourth scene on the onset it ends, as one request.
 * "Fill · Bar 8 → Drop" while it waits, "Filling → Drop" while the fill plays; pressing it
 * again cancels it.
 */
function FillIntoButton({
  fill,
  reasonId,
  onUnavailable,
}: {
  fill: FillControls;
  reasonId: string;
  onUnavailable?: (reason: string) => void;
}) {
  const own = fillIntoJob(fill.job);
  const state = own ? own.status : 'idle';
  const phrase = fillPhrase(fill.at, fill.phraseBars);
  const aria = fillIntoAria(fill.job, fill.intoName, phrase);
  const reason = fillIntoReason(fill);
  return (
    <button
      type="button"
      className={cx('fill-into-button tap', own && 'is-on')}
      data-state={state}
      aria-disabled={reason !== null || undefined}
      aria-label={aria}
      aria-describedby={reason ? reasonId : undefined}
      title={reason ?? aria}
      onClick={reason !== null ? () => onUnavailable?.(`Fill → ${fill.intoName}: ${reason}`) : fill.onFillInto}
    >
      {fillIntoLabel(fill.job, fill.intoName)}
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
  onCrash,
}: {
  scene: Scene;
  scenes: Scene[];
  description: string;
  onClose: () => void;
  onCapture: () => void;
  onRename: (name: string) => boolean;
  onDuplicate: (to: SceneSlotId) => void;
  onReset: () => void;
  onCrash: (crash: boolean) => void;
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
      {/* Saved with the scene; stays open so the change is seen. Undo takes it back. */}
      <label className="scene-menu-check">
        <input type="checkbox" checked={scene.crash} onChange={(e) => onCrash(e.target.checked)} />
        <span>Crash on launch</span>
      </label>
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
