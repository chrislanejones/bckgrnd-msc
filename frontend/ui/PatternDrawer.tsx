/**
 * The pattern editor, in the drawer that used to show the pattern read-only.
 *
 * It edits the working patterns (`lib/workspace.ts`) and says plainly what is being
 * edited, what is playing and whether the change is in the music yet:
 *
 *     Editing  Closed hat · Bar 9 · Break
 *     Playing  Bar 5 · Groove
 *     Change   Queued for bar 6
 *
 * Editing never moves the playhead. Follow Playback shows the playing bar until the
 * user picks a bar or starts an edit; Hear Bar is the one explicit way to go and
 * listen to the bar on screen. On a phone the grid shows eight steps at a time, with
 * the real step numbers, and steps through the song a half bar at a time.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Headphones, Lock, Redo2, Undo2, Unlock, X } from 'lucide-react';
import {
  changeSummary,
  clearRange,
  copyRange,
  deleteEvents,
  duplicateBar,
  editNote,
  humanize,
  addNote,
  paintHits,
  pasteClip,
  setVelocities,
  type Clip,
} from '../lib/editing';
import type { Instrument } from '../lib/instrument';
import {
  BARS,
  STEPS_PER_BAR,
  laneSpec,
  type LaneId,
  type NoteEvent,
  type Pattern,
} from '../lib/patterns';
import { PARTS } from '../lib/stems';
import type { StemId } from '../lib/types';
import { Segmented, cx } from './controls';
import { DrumGrid } from './pattern/DrumGrid';
import { PianoRoll } from './pattern/PianoRoll';
import { VariationPanel } from './pattern/VariationPanel';
import { VelocityLane } from './pattern/VelocityLane';
import { PATTERN_REASON, noteName, partOf, pct, stepLabel, type Viewport } from './pattern/shared';

const DRUMS: LaneId[] = ['kick', 'clap', 'hat', 'hatOpen'];
type Tab = 'drums' | 'bass' | 'lead' | 'stab' | 'pad' | 'arp';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'drums', label: 'Drums' },
  { value: 'bass', label: 'Bass' },
  { value: 'lead', label: 'Lead' },
  { value: 'stab', label: 'Stab' },
  { value: 'pad', label: 'Pad' },
  { value: 'arp', label: 'Arp' },
];

const tabOf = (stem: StemId): Tab => (stem === 'kick' || stem === 'clap' || stem === 'hats' ? 'drums' : stem);
const laneOfStem = (stem: StemId): LaneId | null =>
  stem === 'kick' ? 'kick' : stem === 'clap' ? 'clap' : stem === 'hats' ? 'hat' : null;
const stemOfLane = (lane: LaneId): StemId =>
  lane === 'hat' || lane === 'hatOpen' ? 'hats' : (lane as StemId);

/** A copied bar: one lane, or all four drum lanes together. */
type Copied = { clips: Clip[]; label: string; drums: boolean };

type Humanizing = { amount: number; preserveAccents: boolean; seed: number; range: 'bar' | 'part' | 'lane' };

const newSeed = () => Math.floor(Math.random() * 99_999) + 1;

export function PatternDrawer({
  open,
  onClose,
  inst,
  stem,
  onStem,
  phone,
}: {
  open: boolean;
  onClose: () => void;
  inst: Instrument;
  stem: StemId;
  onStem: (stem: StemId) => void;
  phone: boolean;
}) {
  const ws = inst.patterns;
  const track = inst.track;
  const closeRef = useRef<HTMLButtonElement>(null);

  const tab = tabOf(stem);
  const [drumLane, setDrumLane] = useState<LaneId>(laneOfStem(stem) ?? 'kick');
  // Picking Kick, Clap or Hats anywhere in the app focuses that drum row.
  useEffect(() => {
    const lane = laneOfStem(stem);
    if (lane && !(lane === 'hat' && drumLane === 'hatOpen')) setDrumLane(lane);
    // Only when the app's stem changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stem]);
  const focusLane: LaneId = tab === 'drums' ? drumLane : tab;
  const spec = laneSpec(focusLane);

  const [follow, setFollow] = useState(true);
  const [bar, setBar] = useState(0);
  const [half, setHalf] = useState(0);
  const following = follow && inst.playing && inst.songStep >= 0;
  const shownBar = following ? inst.bar : bar;
  const shownHalf = following ? (inst.songStep % STEPS_PER_BAR >= 8 ? 1 : 0) : half;
  const view: Viewport = {
    bar: shownBar,
    cols: phone
      ? Array.from({ length: 8 }, (_, i) => shownHalf * 8 + i)
      : Array.from({ length: STEPS_PER_BAR }, (_, i) => i),
  };

  const [selection, setSelection] = useState<string[]>([]);
  const [noteSel, setNoteSel] = useState<string | null>(null);
  const [velMode, setVelMode] = useState<'set' | 'scale'>('set');
  const [scope, setScope] = useState<'lane' | 'drums'>('lane');
  const [copied, setCopied] = useState<Copied | null>(null);
  const [dest, setDest] = useState<number>(-1);
  const [message, setMessage] = useState('');
  const [panel, setPanel] = useState<'none' | 'humanize' | 'vary'>('none');
  const [hz, setHz] = useState<Humanizing>({ amount: 0.5, preserveAccents: true, seed: newSeed(), range: 'bar' });
  const lastLen = useRef<Record<string, number>>({ bass: 2, lead: 2 });

  // A new lane, bar or track starts with nothing selected.
  useEffect(() => {
    setSelection([]);
    setNoteSel(null);
  }, [focusLane, shownBar, track?.id]);
  useEffect(() => {
    setPanel('none');
    setCopied(null);
    setMessage('');
  }, [track?.id]);

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  const frozen = Boolean(ws.preview) || Boolean(inst.mixing);
  const display = (lane: LaneId): Pattern | null =>
    ws.preview?.lane === lane ? ws.preview.candidate : ws.lane(lane);

  const lockedEvents = useMemo(() => {
    const out = new Set<string>();
    for (const [lane, ids] of Object.entries(ws.locks.events)) for (const id of ids ?? []) out.add(`${lane}:${id}`);
    return out;
  }, [ws.locks]);

  if (!track) return null;

  /** Starting an edit or choosing a bar pins the view where it is. */
  function pin(nextBar = shownBar, nextHalf = shownHalf) {
    setFollow(false);
    setBar(nextBar);
    setHalf(nextHalf);
  }

  function commit(label: string, lanes: Partial<Record<LaneId, Pattern>>) {
    pin();
    setMessage('');
    ws.commit(label, lanes);
  }

  const barFrom = shownBar * STEPS_PER_BAR;
  const barTo = barFrom + STEPS_PER_BAR - 1;
  const scopeLanes: LaneId[] = tab === 'drums' && scope === 'drums' ? DRUMS : [focusLane];
  const scopeName = tab === 'drums' && scope === 'drums' ? 'Drums' : spec.label;
  const scopeLabel = `${scopeName} · Bar ${shownBar + 1}`;
  const editableLane = spec.editable;
  const canEdit = editableLane && !frozen;

  // ---- Drum operations -------------------------------------------------------

  function paint(lane: LaneId, steps: number[], mode: 'add' | 'remove') {
    const p = ws.lane(lane);
    if (!p) return;
    const next = paintHits(p, steps, mode, laneSpec(lane).velocity);
    if (next.events.length === p.events.length) return;
    commit(`${mode === 'add' ? 'Paint' : 'Erase'} ${laneSpec(lane).label.toLowerCase()}`, { [lane]: next });
  }

  function velocity(ids: string[], how: 'set' | 'scale', value: number) {
    const p = ws.lane(drumLane);
    if (!p || ids.length === 0) return;
    commit(`Velocity ${laneSpec(drumLane).label.toLowerCase()}`, { [drumLane]: setVelocities(p, ids, how, value) });
  }

  // ---- Bar operations (scoped) ----------------------------------------------

  function copy() {
    const clips = scopeLanes.map((l) => copyRange(ws.lane(l)!, barFrom, barTo, `${laneSpec(l).label} · Bar ${shownBar + 1}`));
    setCopied({ clips, label: scopeLabel, drums: scopeLanes.length > 1 });
    setMessage(`Copied ${scopeLabel}`);
  }

  const pasteTargets: LaneId[] = copied ? (copied.drums ? DRUMS : [focusLane]) : [];
  const pasteOk =
    copied !== null &&
    canEdit &&
    (copied.drums ? tab === 'drums' : laneSpec(copied.clips[0]!.lane).kind === spec.kind);
  const pasteDest = copied?.drums ? `Drums · Bar ${shownBar + 1}` : `${spec.label} · Bar ${shownBar + 1}`;

  function paste() {
    if (!copied || !pasteOk) return;
    const out: Partial<Record<LaneId, Pattern>> = {};
    pasteTargets.forEach((lane, i) => {
      const clip = copied.drums ? copied.clips[i]! : copied.clips[0]!;
      const next = pasteClip(ws.lane(lane)!, clip, barFrom);
      if (next) out[lane] = next;
    });
    commit(`Paste ${copied.label} over ${pasteDest}`, out);
  }

  function duplicate() {
    if (dest < 0 || dest === shownBar) return;
    const out: Partial<Record<LaneId, Pattern>> = {};
    for (const lane of scopeLanes) {
      const next = duplicateBar(ws.lane(lane)!, shownBar, dest);
      if (next) out[lane] = next;
    }
    commit(`Duplicate ${scopeName} bar ${shownBar + 1} to bar ${dest + 1}`, out);
    setMessage(`Duplicated ${scopeName} bar ${shownBar + 1} to bar ${dest + 1}`);
  }

  function clear() {
    const out: Partial<Record<LaneId, Pattern>> = {};
    for (const lane of scopeLanes) out[lane] = clearRange(ws.lane(lane)!, barFrom, barTo);
    commit(`Clear ${scopeLabel}`, out);
  }

  // ---- Notes -----------------------------------------------------------------

  const notePattern = tab !== 'drums' ? display(focusLane) : null;
  const selectedNote =
    notePattern && noteSel ? (notePattern.events.find((e) => e.id === noteSel) as NoteEvent | undefined) : undefined;

  function addAt(step: number, pitch: number) {
    const p = ws.lane(focusLane)!;
    const len = lastLen.current[focusLane] ?? 2;
    const next = addNote(p, step, pitch, len, spec.velocity);
    if (!next) {
      setMessage('No note added: there is already a note sounding there');
      return;
    }
    const added = next.events.find((e) => !p.events.some((x) => x.id === e.id));
    commit(`Add ${noteName(pitch)}`, { [focusLane]: next });
    if (added) setNoteSel(added.id);
  }

  function changeNote(id: string, change: Parameters<typeof editNote>[2], label = 'Edit note') {
    const p = ws.lane(focusLane)!;
    const next = editNote(p, id, change);
    if (!next) {
      setMessage('Not changed: it would overlap another note or leave the song');
      return;
    }
    if (change.len) lastLen.current[focusLane] = change.len;
    commit(label, { [focusLane]: next });
  }

  // ---- Humanize --------------------------------------------------------------

  const hzRange = (): [number, number, string] => {
    if (hz.range === 'lane') return [0, 255, 'whole lane'];
    if (hz.range === 'part') {
      const first = Math.floor(shownBar / 4) * 4;
      return [first * 16, first * 16 + 63, `bars ${first + 1}–${first + 4} (${partOf(shownBar)})`];
    }
    return [barFrom, barTo, `bar ${shownBar + 1}`];
  };

  function previewHumanize(settings = hz) {
    const source = ws.lane(focusLane);
    if (!source) return;
    const [from, to, where] = (() => {
      if (settings.range === 'lane') return [0, 255, 'whole lane'] as const;
      if (settings.range === 'part') {
        const first = Math.floor(shownBar / 4) * 4;
        return [first * 16, first * 16 + 63, `bars ${first + 1}–${first + 4}`] as const;
      }
      return [barFrom, barTo, `bar ${shownBar + 1}`] as const;
    })();
    const candidate = humanize(source, { ...settings, from, to }, ws.locks);
    pin();
    ws.startPreview({
      lane: focusLane,
      candidate,
      title: `Humanize ${spec.label.toLowerCase()} · seed ${settings.seed}`,
      summary: changeSummary(source, candidate),
      scope: `${spec.label} · ${where} · amount ${pct(settings.amount)}%${settings.preserveAccents ? ' · accents kept' : ''}`,
    });
  }

  // A humanize being previewed follows its settings, always from the source.
  function setHumanize(next: Humanizing) {
    setHz(next);
    if (ws.preview?.title.startsWith('Humanize')) previewHumanize(next);
  }

  // ---- Keys ------------------------------------------------------------------

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) ws.redo();
      else ws.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      ws.redo();
    }
  }

  // ---- Status lines ------------------------------------------------------------

  const editing = `${tab === 'drums' ? spec.label : spec.label} · Bar ${shownBar + 1} · ${partOf(shownBar)}${phone ? ` · steps ${view.cols[0]! + 1}–${view.cols.at(-1)! + 1}` : ''}`;
  const playingLine = inst.playing && inst.songStep >= 0 ? `Bar ${inst.bar + 1} · ${partOf(inst.bar)}` : 'Stopped';
  const s = ws.status;
  const change =
    s.state === 'none'
      ? 'No edits'
      : s.state === 'sending'
        ? 'Sending'
        : s.state === 'queued'
          ? `Queued for bar ${s.bar}`
          : s.state === 'audible'
            ? 'In the music'
            : s.state === 'cancelled'
              ? `Withdrawn: ${PATTERN_REASON[s.reason ?? 10] ?? 'cancelled'}`
              : `Not applied: ${PATTERN_REASON[s.reason ?? 1] ?? 'refused'}`;

  const playStep = inst.playing ? inst.songStep : -1;
  const drumPatterns = DRUMS.map((l) => display(l)!).filter(Boolean);
  const focusPattern = display(drumLane);
  const selectedHits = new Set(selection);
  const selectedEvents = focusPattern ? focusPattern.events.filter((e) => selectedHits.has(e.id)) : [];
  const laneLocked = ws.locks.lanes.includes(focusLane);

  function stepView(dir: -1 | 1) {
    let b = shownBar;
    let h = shownHalf + dir;
    if (h > 1) {
      h = 0;
      b += 1;
    } else if (h < 0) {
      h = 1;
      b -= 1;
    }
    if (b < 0 || b >= BARS) return;
    pin(b, h);
  }

  return (
    <section
      id="pattern-drawer"
      className={cx('drawer', 'editor', open && 'is-open')}
      aria-label="Pattern editor"
      data-views="edit"
      data-editor=""
      onKeyDown={onKey}
    >
      <header className="drawer-head">
        <div className="drawer-title">
          <h2 className="panel-title">Pattern</h2>
        </div>
        <Segmented<Tab>
          label="Lane"
          hideLabel
          value={tab}
          onPick={(t) => onStem(t === 'drums' ? stemOfLane(drumLane) : t)}
          options={TABS}
        />
        <button
          ref={closeRef}
          type="button"
          className="icon-button drawer-close"
          aria-label="Close the pattern"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="editor-status" aria-live="polite">
        <dl className="editor-lines">
          <div>
            <dt>Editing</dt>
            <dd data-testid="editing-line">{editing}</dd>
          </div>
          <div>
            <dt>Playing</dt>
            <dd data-testid="playing-line">{playingLine}</dd>
          </div>
          <div>
            <dt>Change</dt>
            <dd data-testid="change-line" data-state={s.state}>
              {change}
            </dd>
          </div>
        </dl>
        <div className="editor-status-actions">
          <button
            type="button"
            className="segment tap"
            aria-pressed={follow}
            onClick={() => (follow ? pin() : setFollow(true))}
          >
            Follow playback
          </button>
          <button
            type="button"
            className="segment tap"
            disabled={Boolean(inst.mixing)}
            onClick={() => {
              pin();
              void inst.auditionBar(shownBar);
            }}
          >
            <Headphones className="size-3.5" aria-hidden /> Hear bar {shownBar + 1}
          </button>
        </div>
      </div>

      <nav className="bar-picker" aria-label="Bars">
        {PARTS.map((part, p) => (
          <div key={part} className="bar-part" role="group" aria-label={part}>
            <span className="bar-part-name" aria-hidden>
              {part}
            </span>
            {[0, 1, 2, 3].map((i) => {
              const b = p * 4 + i;
              return (
                <button
                  key={b}
                  type="button"
                  className={cx('bar-button tap', inst.playing && inst.bar === b && 'is-playing')}
                  aria-pressed={b === shownBar}
                  aria-label={`Bar ${b + 1}${inst.playing && inst.bar === b ? ', playing' : ''}`}
                  onClick={() => pin(b, 0)}
                >
                  {b + 1}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="editor-body">
        {phone ? (
          <div className="half-nav">
            <button type="button" className="icon-button" aria-label="Previous steps" onClick={() => stepView(-1)}>
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="tabular-nums">
              Bar {shownBar + 1} · steps {view.cols[0]! + 1}–{view.cols.at(-1)! + 1}
            </span>
            <button type="button" className="icon-button" aria-label="Next steps" onClick={() => stepView(1)}>
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        ) : null}

        {ws.preview ? (
          <div className="preview-bar" role="region" aria-label="Preview">
            <div>
              <p className="preview-title">Previewing: {ws.preview.title}</p>
              <p className="preview-scope">{ws.preview.scope}</p>
              <p className="preview-summary">{ws.preview.summary}</p>
              <ol className="preview-steps" aria-label="Preview progress">
                <li className="is-done">Source kept</li>
                <li className={cx(s.state !== 'none' && 'is-done')}>Prepared</li>
                <li className={cx((s.state === 'queued' || s.state === 'audible') && 'is-done')}>
                  {s.state === 'queued' ? `Queued for bar ${s.bar}` : 'Queued'}
                </li>
                <li className={cx(s.state === 'audible' && 'is-done')}>Playing</li>
              </ol>
            </div>
            <div className="preview-actions">
              <button type="button" className="segment tap is-primary" onClick={() => ws.keepPreview()}>
                Keep
              </button>
              <button type="button" className="segment tap" onClick={() => ws.revertPreview()}>
                Revert
              </button>
            </div>
          </div>
        ) : null}

        {inst.mixing ? <p className="editor-note">A mix is running. Editing waits until it finishes.</p> : null}

        {tab === 'drums' ? (
          <div className="drum-editor">
            <div className="step-numbers" aria-hidden>
              <span />
              <div className="step-groups">
                {groupsOf(view.cols).map((g) => (
                  <div key={g[0]} className="step-group">
                    {g.map((c) => (
                      <span
                        key={c}
                        className={cx('step-number', c % 4 === 0 && 'is-beat', playStep === barFrom + c && 'is-playhead')}
                      >
                        {c + 1}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <DrumGrid
              lanes={drumPatterns}
              view={view}
              playStep={playStep}
              focusLane={drumLane}
              selection={selectedHits}
              lockedLanes={ws.locks.lanes}
              lockedEvents={lockedEvents}
              disabled={frozen}
              onFocusLane={(l) => {
                setDrumLane(l);
                onStem(stemOfLane(l));
              }}
              onPaint={paint}
            />
            {focusPattern ? (
              <VelocityLane
                pattern={focusPattern}
                view={view}
                selection={selectedHits}
                mode={velMode}
                disabled={frozen}
                onSelect={setSelection}
                onCommit={velocity}
              />
            ) : null}
          </div>
        ) : notePattern ? (
          <>
            {!editableLane ? (
              <p className="editor-note">
                {spec.label} plays as written in this version: shown here with its chords intact, not editable yet.
              </p>
            ) : null}
            <PianoRoll
              pattern={notePattern}
              view={view}
              playStep={playStep}
              selected={noteSel}
              readOnly={!editableLane}
              disabled={frozen}
              lockedEvents={lockedEvents}
              onSelect={setNoteSel}
              onAdd={addAt}
              onChange={(id, c) => changeNote(id, c, c.len ? 'Resize note' : 'Move note')}
              onDelete={(id) => {
                commit('Delete note', { [focusLane]: deleteEvents(ws.lane(focusLane)!, [id]) });
                setNoteSel(null);
              }}
              onRefused={setMessage}
            />
          </>
        ) : null}

        {/* The inspector: exact values for what is selected. */}
        <div className="editor-inspector" role="group" aria-label="Selection">
          {tab === 'drums' ? (
            <DrumInspector
              lane={laneSpec(drumLane).label}
              events={selectedEvents}
              mode={velMode}
              onMode={setVelMode}
              disabled={frozen}
              onSet={(v) => velocity(selection, 'set', v)}
              onScale={(f) => velocity(selection, 'scale', f)}
              onSelectBar={() =>
                setSelection(
                  (focusPattern?.events ?? [])
                    .filter((e) => e.step >= barFrom && e.step <= barTo)
                    .map((e) => e.id),
                )
              }
              onClearSelection={() => setSelection([])}
              locked={(id) => lockedEvents.has(`${drumLane}:${id}`)}
              onLock={(ids) => ids.forEach((id) => ws.toggleEventLock(drumLane, id))}
            />
          ) : selectedNote && editableLane ? (
            <NoteInspector
              note={selectedNote}
              disabled={frozen}
              locked={lockedEvents.has(`${focusLane}:${selectedNote.id}`)}
              onLock={() => ws.toggleEventLock(focusLane, selectedNote.id)}
              onChange={(c, label) => changeNote(selectedNote.id, c, label)}
              onDelete={() => {
                commit('Delete note', { [focusLane]: deleteEvents(ws.lane(focusLane)!, [selectedNote.id]) });
                setNoteSel(null);
              }}
            />
          ) : selectedNote ? (
            <p className="editor-hint">
              {selectedNote.notes.map(noteName).join(' ')} · {stepLabel(selectedNote.step)} · {selectedNote.len} steps ·{' '}
              {pct(selectedNote.vel)}%{selectedNote.accent ? ' · accent' : ''}
            </p>
          ) : (
            <p className="editor-hint">
              {editableLane
                ? 'Click to add a note. Drag a note to move it, its right edge to resize. Select one for exact values.'
                : 'Select a note to see its pitches and length.'}
            </p>
          )}
        </div>

        <div className="editor-actions" role="toolbar" aria-label="Edit">
          {tab === 'drums' ? (
            <Segmented<'lane' | 'drums'>
              label="Scope"
              hideLabel
              value={scope}
              onPick={setScope}
              options={[
                { value: 'lane', label: spec.label, aria: `Scope: ${spec.label} only` },
                { value: 'drums', label: 'All drums', aria: 'Scope: all four drum lanes' },
              ]}
            />
          ) : null}
          <button type="button" className="segment tap" onClick={copy} aria-label={`Copy ${scopeLabel}`}>
            Copy
          </button>
          <button
            type="button"
            className="segment tap"
            disabled={!pasteOk}
            onClick={paste}
            aria-label={copied ? `Paste ${copied.label} over ${pasteDest}` : 'Paste (nothing copied)'}
          >
            Paste
          </button>
          <span className="duplicate">
            <label className="sr-only" htmlFor="dup-dest">
              Duplicate to bar
            </label>
            <select
              id="dup-dest"
              className="dup-select"
              value={dest}
              disabled={!canEdit}
              onChange={(e) => setDest(Number(e.target.value))}
            >
              <option value={-1}>Duplicate to…</option>
              {Array.from({ length: BARS }, (_, b) =>
                b === shownBar ? null : (
                  <option key={b} value={b}>
                    Bar {b + 1}
                  </option>
                ),
              )}
            </select>
            <button
              type="button"
              className="segment tap"
              disabled={!canEdit || dest < 0 || dest === shownBar}
              onClick={duplicate}
              aria-label={dest >= 0 ? `Duplicate ${scopeLabel} to bar ${dest + 1}` : 'Duplicate (pick a bar)'}
            >
              Duplicate
            </button>
          </span>
          <button
            type="button"
            className="segment tap"
            disabled={!canEdit}
            onClick={clear}
            aria-label={`Clear ${scopeLabel}`}
          >
            Clear
          </button>
          <span className="editor-actions-gap" />
          <button
            type="button"
            className="segment tap"
            aria-pressed={panel === 'humanize'}
            disabled={!editableLane || Boolean(inst.mixing)}
            onClick={() => setPanel(panel === 'humanize' ? 'none' : 'humanize')}
          >
            Humanize
          </button>
          <button
            type="button"
            className="segment tap"
            aria-pressed={panel === 'vary'}
            disabled={!editableLane || Boolean(inst.mixing)}
            onClick={() => setPanel(panel === 'vary' ? 'none' : 'vary')}
          >
            Vary
          </button>
          <button
            type="button"
            className="segment tap"
            disabled={!ws.canUndo}
            onClick={() => ws.undo()}
            aria-label={ws.canUndo ? `Undo ${ws.undoLabel}` : 'Undo'}
            title={ws.canUndo ? `Undo ${ws.undoLabel}` : undefined}
          >
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
          <button
            type="button"
            className="segment tap"
            disabled={!ws.canRedo}
            onClick={() => ws.redo()}
            aria-label={ws.canRedo ? `Redo ${ws.redoLabel}` : 'Redo'}
            title={ws.canRedo ? `Redo ${ws.redoLabel}` : undefined}
          >
            <Redo2 className="size-3.5" aria-hidden /> Redo
          </button>
          <button
            type="button"
            className="segment tap"
            aria-pressed={laneLocked}
            onClick={() => ws.toggleLaneLock(focusLane)}
            aria-label={`${laneLocked ? 'Unlock' : 'Lock'} ${spec.label} against Humanize and Vary`}
          >
            {laneLocked ? <Lock className="size-3.5" aria-hidden /> : <Unlock className="size-3.5" aria-hidden />}{' '}
            {laneLocked ? 'Locked' : 'Lock lane'}
          </button>
        </div>

        {panel === 'humanize' ? (
          <div className="editor-panel" role="group" aria-label="Humanize">
            <p className="panel-lede">
              Humanize: {spec.label} · {hzRange()[2]}. Velocity only; locked hits
              {hz.preserveAccents ? ' and accents' : ''} stay as they are. Always worked out from the pattern as it is now,
              so trying amounts never wears it down.
            </p>
            <div className="panel-row">
              <label className="field">
                <span>Amount</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={pct(hz.amount)}
                  onChange={(e) => setHumanize({ ...hz, amount: Number(e.target.value) / 100 })}
                  aria-valuetext={`${pct(hz.amount)}%`}
                />
                <output className="tabular-nums">{pct(hz.amount)}%</output>
              </label>
              <label className="field check">
                <input
                  type="checkbox"
                  checked={hz.preserveAccents}
                  onChange={(e) => setHumanize({ ...hz, preserveAccents: e.target.checked })}
                />
                <span>Preserve accents</span>
              </label>
              <Segmented<Humanizing['range']>
                label="Range"
                value={hz.range}
                onPick={(range) => setHumanize({ ...hz, range })}
                options={[
                  { value: 'bar', label: `Bar ${shownBar + 1}` },
                  { value: 'part', label: partOf(shownBar) },
                  { value: 'lane', label: 'Whole lane' },
                ]}
              />
              <label className="field">
                <span>Seed</span>
                <input
                  type="number"
                  min={1}
                  max={99999}
                  value={hz.seed}
                  onChange={(e) => setHumanize({ ...hz, seed: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
                />
              </label>
              <button type="button" className="segment tap" onClick={() => setHumanize({ ...hz, seed: newSeed() })}>
                New seed
              </button>
              <button
                type="button"
                className="segment tap is-primary"
                disabled={Boolean(ws.preview) && !ws.preview?.title.startsWith('Humanize')}
                onClick={() => previewHumanize()}
              >
                Preview
              </button>
            </div>
          </div>
        ) : null}

        {panel === 'vary' ? (
          <VariationPanel
            inst={inst}
            lane={focusLane}
            bar={shownBar}
            onPin={() => pin()}
            onMessage={setMessage}
          />
        ) : null}

        <p className="editor-message" role="status">
          {message}
        </p>
      </div>
    </section>
  );
}

function groupsOf(cols: number[]): number[][] {
  const out: number[][] = [];
  for (const c of cols) {
    const last = out.at(-1);
    if (last && Math.floor(last[0]! / 4) === Math.floor(c / 4)) last.push(c);
    else out.push([c]);
  }
  return out;
}

/** A number field that commits on Enter or blur, and shows the value otherwise. */
function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || text.trim() === '') {
      setText(String(value));
      return;
    }
    const v = Math.min(max, Math.max(min, Math.round(n)));
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done();
          if (e.key === 'Escape') setText(String(value));
        }}
      />
      {suffix ? <span className="field-suffix">{suffix}</span> : null}
    </label>
  );
}

function DrumInspector({
  lane,
  events,
  mode,
  onMode,
  disabled,
  onSet,
  onScale,
  onSelectBar,
  onClearSelection,
  locked,
  onLock,
}: {
  lane: string;
  events: Array<{ id: string; step: number; vel: number }>;
  mode: 'set' | 'scale';
  onMode: (m: 'set' | 'scale') => void;
  disabled: boolean;
  onSet: (v: number) => void;
  onScale: (f: number) => void;
  onSelectBar: () => void;
  onClearSelection: () => void;
  locked: (id: string) => boolean;
  onLock: (ids: string[]) => void;
}) {
  const n = events.length;
  const avg = n ? events.reduce((a, e) => a + e.vel, 0) / n : 0;
  const allLocked = n > 0 && events.every((e) => locked(e.id));
  return (
    <div className="inspector-row">
      <span className="inspector-what">
        {n === 0
          ? `${lane}: nothing selected`
          : n === 1
            ? `${lane} · bar ${Math.floor(events[0]!.step / 16) + 1}, step ${(events[0]!.step % 16) + 1}`
            : `${n} ${lane.toLowerCase()} hits selected`}
      </span>
      {n > 1 ? (
        <Segmented<'set' | 'scale'>
          label="Together"
          hideLabel
          value={mode}
          onPick={onMode}
          options={[
            { value: 'set', label: 'Set together', aria: 'Velocity: set every selected hit to the same value' },
            { value: 'scale', label: 'Adjust together', aria: 'Velocity: scale the selected hits together' },
          ]}
        />
      ) : null}
      {n > 0 && (mode === 'set' || n === 1) ? (
        <NumberField
          label="Velocity"
          value={pct(n === 1 ? events[0]!.vel : avg)}
          min={2}
          max={100}
          suffix="%"
          disabled={disabled}
          onCommit={(v) => onSet(v / 100)}
        />
      ) : null}
      {n > 1 && mode === 'scale' ? (
        <NumberField label="Scale" value={100} min={1} max={500} suffix="%" disabled={disabled} onCommit={(v) => onScale(v / 100)} />
      ) : null}
      <button type="button" className="segment tap" onClick={onSelectBar}>
        Select bar
      </button>
      {n > 0 ? (
        <>
          <button type="button" className="segment tap" onClick={onClearSelection}>
            Select none
          </button>
          <button
            type="button"
            className="segment tap"
            aria-pressed={allLocked}
            onClick={() => onLock(events.filter((e) => locked(e.id) === allLocked).map((e) => e.id))}
          >
            {allLocked ? 'Unlock hits' : 'Lock hits'}
          </button>
        </>
      ) : null}
    </div>
  );
}

function NoteInspector({
  note,
  disabled,
  locked,
  onLock,
  onChange,
  onDelete,
}: {
  note: NoteEvent;
  disabled: boolean;
  locked: boolean;
  onLock: () => void;
  onChange: (c: Parameters<typeof editNote>[2], label: string) => void;
  onDelete: () => void;
}) {
  const bar = Math.floor(note.step / 16);
  const col = note.step % 16;
  const root = note.notes[0]!;
  return (
    <div className="inspector-row">
      <span className="inspector-what">
        {note.notes.length > 1 ? `Chord ${note.notes.map(noteName).join(' ')}` : noteName(root)}
      </span>
      <NumberField
        label={note.notes.length > 1 ? 'Root' : 'Pitch'}
        value={root}
        min={0}
        max={127}
        disabled={disabled}
        onCommit={(v) => onChange({ semitones: v - root }, 'Transpose note')}
      />
      <NumberField
        label="Bar"
        value={bar + 1}
        min={1}
        max={16}
        disabled={disabled}
        onCommit={(v) => onChange({ step: (v - 1) * 16 + col }, 'Move note')}
      />
      <NumberField
        label="Step"
        value={col + 1}
        min={1}
        max={16}
        disabled={disabled}
        onCommit={(v) => onChange({ step: bar * 16 + v - 1 }, 'Move note')}
      />
      <NumberField
        label="Length"
        value={note.len}
        min={1}
        max={256 - note.step}
        suffix="steps"
        disabled={disabled}
        onCommit={(v) => onChange({ len: v }, 'Resize note')}
      />
      <NumberField
        label="Velocity"
        value={pct(note.vel)}
        min={2}
        max={100}
        suffix="%"
        disabled={disabled}
        onCommit={(v) => onChange({ vel: v / 100 }, 'Note velocity')}
      />
      <label className="field check">
        <input
          type="checkbox"
          checked={note.accent}
          disabled={disabled}
          onChange={(e) => onChange({ accent: e.target.checked }, e.target.checked ? 'Accent note' : 'Unaccent note')}
        />
        <span>Accent</span>
      </label>
      <button type="button" className="segment tap" aria-pressed={locked} onClick={onLock}>
        {locked ? 'Unlock note' : 'Lock note'}
      </button>
      <button type="button" className="segment tap" disabled={disabled} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
