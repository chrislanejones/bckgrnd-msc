/**
 * The Record indicator (Night 10) in the transport's `record` slot: one toggle for the
 * performance recording (docs/PERFORMANCE_EVENTS.md), and Clear beside it once a take
 * is stopped.
 *
 * Idle: a hollow dot. Recording: a solid dot that pulses (steady under reduced motion),
 * the count in its name and tooltip ("Recording · 7 events"). Stopped: a solid dot, the
 * take's count, and Clear. The word "Rec" shows where the bar has room; at 1280 and on
 * the phone it is the dot alone, and the name stays the full one.
 */

import { X } from 'lucide-react';
import type { RecordingState } from '../lib/recording';

export type RecordingControls = {
  state: RecordingState;
  count: number;
  startRecording: () => void;
  stopRecording: () => void;
  clearRecording: () => void;
};

const events = (n: number) => `${n} event${n === 1 ? '' : 's'}`;

export function RecordToggle({ recording }: { recording: RecordingControls }) {
  const { state, count } = recording;
  const name =
    state === 'recording'
      ? `Recording · ${events(count)}`
      : state === 'stopped'
        ? `Record a new take · last take ${events(count)}`
        : 'Record the performance';
  const title =
    state === 'recording'
      ? `Recording · ${events(count)} · press to stop`
      : state === 'stopped'
        ? `Take stopped · ${events(count)} · press to record a new take`
        : 'Record the performance: scenes, fills and Rises as applied';
  return (
    <div className="record" data-state={state}>
      <button
        type="button"
        className="record-toggle tap"
        aria-pressed={state === 'recording'}
        aria-label={name}
        title={title}
        onClick={state === 'recording' ? recording.stopRecording : recording.startRecording}
      >
        <span className="record-dot" aria-hidden="true" />
        <span className="record-word" aria-hidden="true">
          Rec
        </span>
      </button>
      {state === 'stopped' ? (
        <button
          type="button"
          className="record-clear tap"
          aria-label={`Clear the take · ${events(count)}`}
          title={`Clear the take (${events(count)})`}
          onClick={recording.clearRecording}
        >
          <X aria-hidden="true" size={12} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}
