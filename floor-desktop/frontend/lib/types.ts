/** The shapes Laravel serves. Kept in one place so a contract change is one edit. */

export type StemId = 'kick' | 'clap' | 'hats' | 'bass' | 'stab' | 'lead' | 'pad' | 'arp';

export type TrackKind = 'house' | 'deep' | 'acid' | 'lofi';

export type Mix = Record<StemId, number>;

export type NoteEvent = {
  notes: number[];
  len: number;
  vel: number;
  accent: boolean;
};

export type StemMeta = {
  id: StemId;
  name: string;
  hint: string;
  keys: string;
};

/** A track as it appears in the library index. */
export type TrackSummary = {
  id: string;
  name: string;
  detail: string;
  kind: TrackKind;
  bpm: number;
  swing: number;
  mix: Mix;
};

/** A fully arranged track, exactly what the engine deserialises. */
export type TrackArrangement = TrackSummary & {
  kick: number[];
  clap: number[];
  hat: number[];
  hatOpen: number[];
  bass: (NoteEvent | null)[];
  stab: (NoteEvent | null)[];
  lead: (NoteEvent | null)[];
  pad: (NoteEvent | null)[];
  arp: (NoteEvent | null)[];
};

export type LibraryResponse = {
  stems: StemMeta[];
  drums: StemId[];
  music: StemId[];
  tracks: TrackSummary[];
  parts?: string[];
};

export type TrackResponse = {
  track: TrackArrangement;
  /** Per-bar, per-stem step activity, for the UI's step rows. */
  activity: Record<StemId, boolean[][]>;
};

export type Preset = {
  id: string;
  name: string;
  trackId: string;
  bpm: number;
  swing: number;
  mix: Mix;
  muted: Record<StemId, boolean>;
  solo: Record<StemId, boolean>;
  updatedAt: string;
};

/** A preset being saved; the id and timestamp are the server's to assign. */
export type PresetDraft = Omit<Preset, 'id' | 'updatedAt'> & { id?: string };