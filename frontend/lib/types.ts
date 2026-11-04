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
  /** Library section the track is filed under, e.g. "EDM". */
  section: string;
  /** Sub-genre within the section, e.g. "House". Titled above its first track. */
  style: string;
  bpm: number;
  swing: number;
  mix: Mix;
};

/** A fully arranged track, exactly what the engine deserialises. */
/** A one-bar drum fill, prepared in PHP (app/Support/Music/Fills.php). */
export type Fill = {
  id: string;
  name: string;
  kick: number[];
  clap: number[];
  hat: number[];
  hatOpen: number[];
};

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
  /**
   * Hand percussion on the hats stem, velocity lanes keyed by instrument (`shaker`,
   * `rim`, `congaHi`, `congaLo`). Only lanes with hits are sent.
   */
  perc?: Record<string, number[]>;
  /** One-bar drum fills. Missing on arrangements exported before Night 3. */
  fills?: Fill[];
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