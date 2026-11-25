/**
 * The Deck panel's Hold FX row (Night 10): the momentary effects, side by side, on the
 * deck's five-column grid. Echo and Filter take columns one and two; Beat Repeat takes
 * column three, with its division picker spanning four and five.
 *
 * `RepeatSlot` is presentational. It takes the engine's state and callbacks as props
 * and holds none of its own, so it renders only once the instrument exposes Repeat.
 */

import type { RepeatDivision } from '../lib/engine';
import { PerformancePad, Segmented } from './controls';

const DIVISIONS: Array<{ value: RepeatDivision; label: string; aria: string }> = [
  { value: 4, label: '1/4', aria: 'Repeat every quarter note' },
  { value: 8, label: '1/8', aria: 'Repeat every eighth note' },
  { value: 16, label: '1/16', aria: 'Repeat every sixteenth note' },
];

export type RepeatControls = {
  /** The engine reports Repeat as held. */
  held: boolean;
  division: RepeatDivision;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onDivision: (division: RepeatDivision) => void;
};

/**
 * Beat Repeat: a momentary pad whose hint shows the division it repeats, then the
 * division as a radio group (one always picked, arrow keys move and pick).
 */
export function RepeatSlot({ held, division, onHoldStart, onHoldEnd, onDivision }: RepeatControls) {
  return (
    <>
      <PerformancePad
        label="Repeat"
        hint={`1/${division}`}
        ariaLabel="Beat repeat, while held"
        latched={held}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
      />
      <div className="repeat-division">
        <Segmented<RepeatDivision>
          radio
          label="Repeat division"
          hideLabel
          value={division}
          onPick={onDivision}
          options={DIVISIONS}
        />
      </div>
    </>
  );
}
