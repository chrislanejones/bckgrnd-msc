/**
 * The edit log: one entry per finished gesture.
 *
 * A knob drag sends hundreds of values to the engine, but it is one edit: the value
 * before the hand went on the control and the value when it came off. Controls report
 * that pair when a gesture ends (pointer up, cancel, lost capture, a key let go, a
 * reset, a typed value) and nowhere else, so this log holds what an undo will step
 * through rather than every intermediate value.
 *
 * Undo and redo over it, together with cuts, solos and track changes, arrive with
 * projects (docs/ROADMAP.md, Night 5). Until then the log is recorded so the gesture
 * boundaries can be tested, and is readable from the console as
 * `window.__BCKGRND_EDITS__()`.
 */

export type Edit = {
  /** The parameter id from contracts/parameters.json, or `stem.<id>.<param>`. */
  id: string;
  from: number;
  to: number;
  at: number;
};

const LIMIT = 500;

class EditHistory {
  private list: Edit[] = [];

  /** Record a finished gesture. A gesture that ended where it started is not an edit. */
  record(id: string, from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || Math.abs(from - to) < 1e-9) return;
    this.list.push({ id, from, to, at: Date.now() });
    if (this.list.length > LIMIT) this.list.splice(0, this.list.length - LIMIT);
  }

  get entries(): readonly Edit[] {
    return this.list;
  }
}

export const editHistory = new EditHistory();
