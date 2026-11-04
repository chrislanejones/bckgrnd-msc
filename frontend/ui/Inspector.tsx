/**
 * The inspector: the effects rack for the master, or the selected stem.
 *
 * Detail lives here rather than on the first screen (docs/DESIGN_PHILOSOPHY.md,
 * "Progressive complexity"). Continuous parameters are knobs; the echo's note
 * divisions stay a stepped row, because a division is a choice, not a position.
 * Every control here is wired to a parameter the engine has and tested
 * (engine-core/tests, tools/verify-audio.mjs); ranges and defaults come from
 * contracts/parameters.json.
 *
 * A control with no audible effect in the current state says so: with the echo
 * off, its feedback and return have nothing to act on and are disabled.
 */

import { useId } from 'react';
import { defaultSend, param, stemRange } from '../lib/contract';
import type { Instrument } from '../lib/instrument';
import { EFFECT_DEFAULTS, MASTER_DEFAULT } from '../lib/instrument';
import {
  BALANCE,
  DECAY,
  FEEDBACK,
  FILTER,
  ISOLATOR,
  LEVEL,
  RESONANCE,
  RETURN,
  ROOM,
  SEND,
  SWING,
  TEMPO,
  WIDTH,
} from '../lib/mappings';
import { STEM_NAMES, type StemState } from '../lib/stems';
import type { StemId, StemMeta } from '../lib/types';
import { ControlLabel, Fader, PerformancePad, Segmented, StatusIndicator, useRangeGesture } from './controls';
import { Knob } from './Knob';
import { useKnobDragSetting, type KnobDrag } from './knobPrefs';

export type InspectorTab = 'master' | 'stem';

const ECHO_NAMES: Record<string, string> = {
  '1/16': 'sixteenth',
  '1/8T': 'eighth triplet',
  '1/8': 'eighth',
  '1/8.': 'dotted eighth',
  '1/4': 'quarter',
  '1/4.': 'dotted quarter',
};

const ECHO_OPTIONS = (param('fx.echoTime').options ?? [])
  .filter((o) => o.value !== 0)
  .map((o) => ({ value: o.value, label: o.label, aria: `Echo every ${ECHO_NAMES[o.label] ?? o.label}` }));

export function Inspector({
  tab,
  onTab,
  stem,
  stemMeta,
  stemState,
  stemStateLabel,
  inst,
  onShowPattern,
}: {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  stem: StemId;
  stemMeta: StemMeta | undefined;
  stemState: StemState;
  stemStateLabel: string;
  inst: Instrument;
  onShowPattern: () => void;
}) {
  return (
    <div className="inspector-body">
      <Segmented<InspectorTab>
        label="Inspect"
        hideLabel
        value={tab}
        onPick={onTab}
        options={[
          { value: 'master', label: 'Master' },
          { value: 'stem', label: STEM_NAMES[stem], aria: `Stem: ${STEM_NAMES[stem]}` },
        ]}
      />
      {tab === 'master' ? (
        <MasterRack inst={inst} />
      ) : (
        <StemControls
          stem={stem}
          meta={stemMeta}
          state={stemState}
          stateLabel={stemStateLabel}
          inst={inst}
          onShowPattern={onShowPattern}
        />
      )}
      <KnobDragSetting />
    </div>
  );
}

/** Whether anything reaches the echo line: the stem sends (echo time on) or the throw. */
function echoLive(inst: Instrument): boolean {
  return inst.echoBeats > 0 || inst.echo;
}

function MasterRack({ inst }: { inst: Instrument }) {
  const { track, effects, setEffect } = inst;
  const echoOn = echoLive(inst);
  const echoNote = !echoOn ? 'Echo is off' : inst.echo ? 'Held open by the throw' : '';
  const echoNoteId = useId();

  return (
    <>
      <fieldset className="inspector-group">
        <legend className="inspector-legend">Tempo and feel</legend>
        <div className="knob-row">
          <Knob
            label="Tempo"
            historyId="transport.bpm"
            value={inst.bpm}
            mapping={TEMPO}
            defaultValue={track?.bpm ?? inst.bpm}
            onChange={inst.setBpm}
          />
          <Knob
            label="Swing"
            historyId="transport.swing"
            value={inst.swing}
            mapping={SWING}
            defaultValue={track?.swing ?? inst.swing}
            onChange={inst.setSwing}
          />
        </div>
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Filter</legend>
        <div className="knob-row">
          <Knob
            label="Cutoff"
            historyId="fx.filter"
            value={inst.filter}
            mapping={FILTER}
            defaultValue={1}
            onChange={inst.setFilter}
          />
          <Knob
            label="Resonance"
            historyId="fx.filterQ"
            value={effects['fx.filterQ']}
            mapping={RESONANCE}
            defaultValue={EFFECT_DEFAULTS['fx.filterQ']}
            onChange={(v) => setEffect('fx.filterQ', v)}
            note={inst.filter >= 0.999 ? 'Heard as it closes' : ''}
          />
        </div>
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Isolators</legend>
        <div className="knob-row">
          {(
            [
              ['low', 'Low', 'fx.low'],
              ['mid', 'Mid', 'fx.mid'],
              ['high', 'High', 'fx.high'],
            ] as const
          ).map(([id, label, historyId]) => (
            <Knob
              key={id}
              label={label}
              historyId={historyId}
              value={inst.bands[id]}
              mapping={ISOLATOR}
              defaultValue={1}
              onChange={(v) => inst.setBand(id, v)}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Echo</legend>
        {/* The echo's state is said once, in the Time label, rather than as the same
            note under both knobs. Screen readers get it on each knob as well. */}
        <Segmented<number>
          label={!echoOn ? 'Time · off' : inst.echo ? 'Time · held open by the throw' : 'Time'}
          value={inst.echoBeats}
          onPick={inst.pickEchoTime}
          options={ECHO_OPTIONS}
        />
        <span id={echoNoteId} className="sr-only">
          {echoNote}
        </span>
        <div className="knob-row">
          <Knob
            label="Feedback"
            historyId="fx.echoFeedback"
            value={effects['fx.echoFeedback']}
            mapping={FEEDBACK}
            defaultValue={EFFECT_DEFAULTS['fx.echoFeedback']}
            onChange={(v) => setEffect('fx.echoFeedback', v)}
            disabled={!echoOn}
            describedBy={echoNote ? echoNoteId : undefined}
          />
          <Knob
            label="Return"
            historyId="fx.echoReturn"
            value={effects['fx.echoReturn']}
            mapping={RETURN}
            defaultValue={EFFECT_DEFAULTS['fx.echoReturn']}
            onChange={(v) => setEffect('fx.echoReturn', v)}
            disabled={!echoOn}
            describedBy={echoNote ? echoNoteId : undefined}
          />
        </div>
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Room</legend>
        <div className="knob-row">
          <Knob
            label="Mix"
            historyId="fx.reverbMix"
            value={effects['fx.reverbMix']}
            mapping={ROOM}
            defaultValue={EFFECT_DEFAULTS['fx.reverbMix']}
            onChange={(v) => setEffect('fx.reverbMix', v)}
          />
          <Knob
            label="Decay"
            historyId="fx.reverbDecay"
            value={effects['fx.reverbDecay']}
            mapping={DECAY}
            defaultValue={EFFECT_DEFAULTS['fx.reverbDecay']}
            onChange={(v) => setEffect('fx.reverbDecay', v)}
            disabled={effects['fx.reverbMix'] <= 0}
            note={effects['fx.reverbMix'] <= 0 ? 'Room is off' : ''}
          />
        </div>
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Output</legend>
        <div className="knob-row">
          <Knob
            label="Width"
            historyId="fx.width"
            value={effects['fx.width']}
            mapping={WIDTH}
            defaultValue={EFFECT_DEFAULTS['fx.width']}
            onChange={(v) => setEffect('fx.width', v)}
          />
          <Knob
            label="Balance"
            historyId="fx.stereo"
            value={inst.stereo}
            mapping={BALANCE}
            defaultValue={0.5}
            onChange={inst.setStereo}
          />
          <Knob
            label="Master"
            historyId="master.level"
            value={inst.master}
            mapping={LEVEL}
            defaultValue={MASTER_DEFAULT}
            onChange={inst.setMaster}
          />
        </div>
      </fieldset>
    </>
  );
}

function StemControls({
  stem,
  meta,
  state,
  stateLabel,
  inst,
  onShowPattern,
}: {
  stem: StemId;
  meta: StemMeta | undefined;
  state: StemState;
  stateLabel: string;
  inst: Instrument;
  onShowPattern: () => void;
}) {
  const volume = inst.vols?.[stem] ?? 0;
  const gesture = useRangeGesture(`stem.${stem}.volume`, volume);
  const sendsOn = inst.echoBeats > 0;
  return (
    <>
      <div className="inspector-stem-head">
        <div>
          <p className="inspector-stem-name">{STEM_NAMES[stem]}</p>
          {meta ? <p className="text-xs text-muted">{meta.hint} · key {meta.keys}</p> : null}
        </div>
        <StatusIndicator state={state} label={stateLabel} />
      </div>
      <div {...gesture}>
        <Fader
          label="Volume"
          display={Math.round(volume * 100)}
          unit="%"
          value={volume}
          {...stemRange('volume')}
          onChange={(v) => inst.setStemVolume(stem, v)}
        />
      </div>
      <div className="knob-row">
        <Knob
          label="Echo send"
          historyId={`stem.${stem}.send`}
          value={inst.sends[stem]}
          mapping={SEND}
          defaultValue={defaultSend(stem)}
          onChange={(v) => inst.setStemSend(stem, v)}
          disabled={!sendsOn}
          note={sendsOn ? '' : 'Echo time is off'}
        />
      </div>
      <div className="inspector-pads">
        <PerformancePad
          size="md"
          label="Solo"
          ariaLabel={`Solo ${STEM_NAMES[stem]}`}
          latched={inst.solo[stem]}
          onPress={() => inst.toggleSolo(stem)}
        />
        <PerformancePad
          size="md"
          label={inst.muted[stem] ? 'Bring in' : 'Cut'}
          ariaLabel={`${inst.muted[stem] ? 'Bring in' : 'Cut'} ${STEM_NAMES[stem]}`}
          latched={inst.muted[stem]}
          onPress={() => inst.toggleMute(stem)}
          keys={meta?.keys}
        />
      </div>
      <div className="inspector-group">
        <ControlLabel>Pattern</ControlLabel>
        <button type="button" className="text-button" onClick={onShowPattern}>
          Show the {STEM_NAMES[stem].toLowerCase()} pattern
        </button>
      </div>
    </>
  );
}

function KnobDragSetting() {
  const { mode, setMode } = useKnobDragSetting();
  return (
    <div className="inspector-setting">
      <Segmented<KnobDrag>
        label="Knobs turn by dragging"
        value={mode}
        onPick={setMode}
        options={[
          { value: 'vertical', label: 'Up and down' },
          { value: 'circular', label: 'Round' },
        ]}
      />
    </div>
  );
}
