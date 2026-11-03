/**
 * The inspector: the detailed controls for the selected stem, or for the master.
 *
 * Detail lives here rather than on the first screen (docs/DESIGN_PHILOSOPHY.md,
 * "Progressive complexity"). Every range and default comes from the parameter
 * registry in contracts/parameters.json.
 */

import { controlRange, param, stemRange } from '../lib/contract';
import type { Instrument } from '../lib/instrument';
import { MASTER_DEFAULT } from '../lib/instrument';
import { STEM_NAMES, type StemState } from '../lib/stems';
import type { StemId, StemMeta } from '../lib/types';
import { ControlLabel, Fader, PerformancePad, Segmented, StatusIndicator } from './controls';

export type InspectorTab = 'master' | 'stem';

/** The balance reads in words: the useful positions are the ends and the middle. */
export function stereoLabel(balance: number): string {
  if (balance <= 0.02) return 'Left';
  if (balance >= 0.98) return 'Right';
  if (Math.abs(balance - 0.5) <= 0.02) return 'Stereo';
  return balance < 0.5
    ? `Left ${Math.round((0.5 - balance) * 200)}%`
    : `Right ${Math.round((balance - 0.5) * 200)}%`;
}

const ECHO_NAMES: Record<string, string> = {
  '1/16': 'sixteenth',
  '1/8T': 'eighth triplet',
  '1/8': 'eighth',
  '1/8.': 'dotted eighth',
  '1/4': 'quarter',
  '1/4.': 'dotted quarter',
};

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
        <MasterControls inst={inst} />
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
    </div>
  );
}

function MasterControls({ inst }: { inst: Instrument }) {
  const { track } = inst;
  const tempo = controlRange('transport.bpm');
  const swing = controlRange('transport.swing');
  const level = controlRange('master.level');
  const band = controlRange('fx.low');
  const filter = controlRange('fx.filter');
  const stereo = controlRange('fx.stereo');
  const echoOptions = (param('fx.echoTime').options ?? []).filter((o) => o.value !== 0);

  return (
    <>
      <fieldset className="inspector-group">
        <legend className="inspector-legend">Tempo and feel</legend>
        <Fader
          label="Tempo"
          display={inst.bpm}
          unit="BPM"
          value={inst.bpm}
          {...tempo}
          atDefault={!track || inst.bpm === track.bpm}
          onChange={inst.setBpm}
          onReset={() => track && inst.setBpm(track.bpm)}
        />
        <Fader
          label="Swing"
          display={Math.round(inst.swing * 100)}
          value={inst.swing}
          {...swing}
          atDefault={!track || inst.swing === track.swing}
          onChange={inst.setSwing}
          onReset={() => track && inst.setSwing(track.swing)}
        />
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Tone</legend>
        {(
          [
            ['low', 'Low'],
            ['mid', 'Mid'],
            ['high', 'High'],
          ] as const
        ).map(([id, label]) => (
          <Fader
            key={id}
            label={label}
            display={Math.round(inst.bands[id] * 100)}
            value={inst.bands[id]}
            {...band}
            atDefault={inst.bands[id] === 1}
            onChange={(v) => inst.setBand(id, v)}
            onReset={() => inst.setBand(id, 1)}
            valueText={`${label} isolator ${Math.round(inst.bands[id] * 100)}%`}
          />
        ))}
        <Fader
          label="Filter"
          display={Math.round(inst.filter * 100)}
          value={inst.filter}
          {...filter}
          atDefault={inst.filter === 1}
          onChange={inst.setFilter}
          onReset={() => inst.setFilter(1)}
        />
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Space</legend>
        <Segmented<number>
          label={inst.echoBeats === 0 ? 'Echo time · off' : 'Echo time'}
          value={inst.echoBeats}
          onPick={inst.pickEchoTime}
          options={echoOptions.map((o) => ({
            value: o.value,
            label: o.label,
            aria: `Echo every ${ECHO_NAMES[o.label] ?? o.label}`,
          }))}
        />
        <Fader
          label="Stereo"
          display={stereoLabel(inst.stereo)}
          value={inst.stereo}
          {...stereo}
          atDefault={inst.stereo === 0.5}
          onChange={inst.setStereo}
          onReset={() => inst.setStereo(0.5)}
          valueText={stereoLabel(inst.stereo)}
          ends={['Left', 'Stereo', 'Right']}
        />
      </fieldset>

      <fieldset className="inspector-group">
        <legend className="inspector-legend">Output</legend>
        <Fader
          label="Master"
          display={Math.round(inst.master * 100)}
          value={inst.master}
          {...level}
          atDefault={inst.master === MASTER_DEFAULT}
          onChange={inst.setMaster}
          onReset={() => inst.setMaster(MASTER_DEFAULT)}
        />
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
  return (
    <>
      <div className="inspector-stem-head">
        <div>
          <p className="inspector-stem-name">{STEM_NAMES[stem]}</p>
          {meta ? <p className="text-xs text-muted">{meta.hint} · key {meta.keys}</p> : null}
        </div>
        <StatusIndicator state={state} label={stateLabel} />
      </div>
      <Fader
        label="Volume"
        display={Math.round(volume * 100)}
        unit="%"
        value={volume}
        {...stemRange('volume')}
        onChange={(v) => inst.setStemVolume(stem, v)}
      />
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
