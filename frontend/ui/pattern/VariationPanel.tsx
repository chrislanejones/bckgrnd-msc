/**
 * Vary: one seeded, constrained candidate for the part of the song on screen.
 *
 * Says before anything is generated what will be varied and what will be kept:
 *
 *     Vary      Closed hat · Bars 9–12 (Break)
 *     Preserve  offbeat hats, locked hits · every other lane
 *
 * The candidate is previewed (Keep or Revert, in the editor's preview bar); the
 * source is untouched until Keep. A melodic lane says up front that it can vary only
 * rhythm and dynamics. A phrase the static build has no variation for is reported as
 * unavailable, with the reason, and nothing is substituted.
 */

import { useRef, useState } from 'react';
import { changeSummary } from '../../lib/editing';
import type { Instrument } from '../../lib/instrument';
import { LANE_IDS, laneSpec, type LaneId } from '../../lib/patterns';
import { usingStaticLibrary } from '../../lib/api';
import { STRENGTHS, STRENGTH_LABEL, requestVariation, type Strength } from '../../lib/variations';
import { Segmented } from '../controls';
import { partOf } from './shared';

const ANCHORS: Partial<Record<LaneId, string>> = {
  kick: 'kicks on the beat',
  clap: 'backbeat claps',
  hat: 'offbeat hats',
  hatOpen: 'offbeat hats',
  bass: 'every pitch, the first note of each bar',
  lead: 'every pitch, the first note of each bar',
};

const RHYTHM_ONLY =
  'Rhythm and dynamics only: no track records its harmony yet, so every pitch (chords too) is kept.';

export function VariationPanel({
  inst,
  lane,
  bar,
  onPin,
  onMessage,
}: {
  inst: Instrument;
  lane: LaneId;
  bar: number;
  onPin: () => void;
  onMessage: (m: string) => void;
}) {
  const ws = inst.patterns;
  // The answer arrives later; it is checked against the instrument as it is then.
  const latest = useRef(inst);
  latest.current = inst;
  const spec = laneSpec(lane);
  const staticBuild = usingStaticLibrary();
  const [strength, setStrength] = useState<Strength>('moderate');
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState('');

  const first = Math.floor(bar / 4) * 4;
  const from = first * 16;
  const to = from + 63;
  const scope = `${spec.label} · Bars ${first + 1}–${first + 4} (${partOf(bar)})`;
  const lockedHere = (ws.locks.events[lane] ?? []).length > 0;
  const laneLocked = ws.locks.lanes.includes(lane);
  const preserve = [ANCHORS[lane], lockedHere ? `locked ${spec.kind === 'drum' ? 'hits' : 'notes'}` : null, 'every other lane']
    .filter(Boolean)
    .join(' · ');

  async function generate() {
    const track = inst.track;
    const source = ws.lane(lane);
    if (!track || !source) return;
    setBusy(true);
    setUnavailable('');
    const context = Object.fromEntries(LANE_IDS.filter((l) => l !== lane && laneSpec(l).kind === 'drum').map((l) => [l, ws.lane(l)!]));
    const res = await requestVariation({ trackId: track.id, lane, from, to, strength, seed, source, locks: ws.locks, context });
    setBusy(false);
    // Edited or reloaded while waiting: this answer was for a phrase that is gone.
    const now = latest.current.patterns.lane(lane);
    if (latest.current.track?.id !== track.id || !now || now.revision !== source.revision || now.id !== source.id) {
      onMessage('The phrase changed while the variation was being made; try again.');
      return;
    }
    if (res.status !== 'ok') {
      setUnavailable(res.reason);
      return;
    }
    onPin();
    latest.current.patterns.startPreview({
      lane,
      candidate: res.candidate,
      title: `${STRENGTH_LABEL[strength]} variation · seed ${seed}`,
      summary: changeSummary(source, res.candidate),
      scope: `${scope} · kept: ${res.preserved.join(', ')}${res.reason ? ` · ${res.reason}` : ''}`,
    });
  }

  return (
    <div className="editor-panel" role="group" aria-label="Vary">
      <dl className="vary-scope">
        <div>
          <dt>Vary</dt>
          <dd data-testid="vary-scope">{scope}</dd>
        </div>
        <div>
          <dt>Preserve</dt>
          <dd>{preserve}</dd>
        </div>
      </dl>
      {spec.kind === 'notes' ? <p className="panel-lede">{RHYTHM_ONLY}</p> : null}
      <div className="panel-row">
        <Segmented<Strength>
          label="Strength"
          value={strength}
          onPick={setStrength}
          options={STRENGTHS.map((s) => ({ value: s, label: STRENGTH_LABEL[s] }))}
        />
        <label className="field">
          <span>Seed</span>
          <input
            type="number"
            min={1}
            max={staticBuild ? 3 : 99999}
            value={seed}
            onChange={(e) => setSeed(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
          />
        </label>
        <button
          type="button"
          className="segment tap"
          onClick={() => setSeed(staticBuild ? (seed % 3) + 1 : Math.floor(Math.random() * 99_999) + 1)}
        >
          New seed
        </button>
        <button
          type="button"
          className="segment tap is-primary"
          disabled={busy || laneLocked || Boolean(ws.preview) || Boolean(inst.mixing)}
          onClick={() => void generate()}
        >
          {busy ? 'Preparing…' : 'Preview variation'}
        </button>
      </div>
      {laneLocked ? <p className="panel-lede">{spec.label} is locked; unlock it to vary it.</p> : null}
      {unavailable ? (
        <p className="vary-unavailable" role="status" data-testid="vary-unavailable">
          Unavailable: {unavailable}
        </p>
      ) : null}
    </div>
  );
}
