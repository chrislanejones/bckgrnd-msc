export type StemId =
  | "kick"
  | "clap"
  | "hats"
  | "bass"
  | "stab"
  | "lead"
  | "pad"
  | "arp";

export type TrackKind = "house" | "deep" | "acid" | "lofi";

export type NoteEvent = {
  notes: number[];
  len: number;
  vel: number;
  accent: boolean;
};

export type Mix = Record<StemId, number>;

export type Track = {
  id: string;
  name: string;
  detail: string;
  kind: TrackKind;
  bpm: number;
  swing: number;
  mix: Mix;
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

export const BARS = 16;
export const STEPS = BARS * 16;
export const PARTS = ["Intro", "Groove", "Break", "Drop"] as const;
const PHRASE = 64;

export const STEM_META: { id: StemId; name: string; hint: string; keys: string }[] = [
  { id: "kick", name: "Kick", hint: "The pulse", keys: "1" },
  { id: "clap", name: "Clap", hint: "Backbeat", keys: "2" },
  { id: "hats", name: "Hats", hint: "The top", keys: "3" },
  { id: "bass", name: "Bass", hint: "Low end", keys: "4" },
  { id: "stab", name: "Stab", hint: "Chords", keys: "5" },
  { id: "lead", name: "Lead", hint: "The hook", keys: "6" },
  { id: "pad", name: "Pad", hint: "The bed", keys: "7" },
  { id: "arp", name: "Arp", hint: "Glitter", keys: "8" },
];

export const DRUMS: StemId[] = ["kick", "clap", "hats"];
export const MUSIC: StemId[] = ["bass", "stab", "lead", "pad", "arp"];

const PITCH: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export function midi(name: string): number {
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!match) throw new Error(`bad note ${name}`);
  let pc = PITCH[match[1]] ?? 0;
  if (match[2] === "#") pc += 1;
  if (match[2] === "b") pc -= 1;
  return (Number(match[3]) + 1) * 12 + pc;
}

export function midiHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

const BASE_MIX: Mix = {
  kick: 0.9,
  clap: 0.5,
  hats: 0.36,
  bass: 0.8,
  stab: 0.38,
  lead: 0.36,
  pad: 0.3,
  arp: 0.32,
};

function blanks(n: number): (NoteEvent | null)[] {
  return Array.from({ length: n }, () => null);
}

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0);
}

function bars(parts: string[]): string {
  for (const part of parts) {
    if (part.length !== 16) throw new Error(`bar ${part.length}: ${part}`);
  }
  return parts.join("");
}

function drums(pattern: string, hit: number, accent: number): number[] {
  if (pattern.length % 16 !== 0) throw new Error(`drums ${pattern.length}`);
  return [...pattern].map((c) => (c === "X" ? accent : c === "x" ? hit : 0));
}

function paint(
  items: Array<[number, number, string | string[], number, number, boolean?]>,
): (NoteEvent | null)[] {
  const span = Math.max(4, ...items.map((item) => item[0] + 1));
  const target = blanks(span * 16);
  for (const [bar, step, pitch, len, vel, accent] of items) {
    const at = bar * 16 + step;
    target[at] = {
      notes: (Array.isArray(pitch) ? pitch : [pitch]).map(midi),
      len,
      vel,
      accent: Boolean(accent),
    };
  }
  return target;
}

function pumpingBass(lines: string[][]): (NoteEvent | null)[] {
  const target = blanks(lines.length * 16);
  lines.forEach((notes, bar) => {
    notes.forEach((name, i) => {
      target[bar * 16 + 2 + i * 4] = {
        notes: [midi(name)],
        len: 2,
        vel: 0.92,
        accent: false,
      };
    });
  });
  return target;
}

function arpCycle(chords: string[][], every: number, vel: number): (NoteEvent | null)[] {
  const target = blanks(chords.length * 16);
  chords.forEach((chord, bar) => {
    let k = 0;
    for (let s = 0; s < 16; s += every) {
      target[bar * 16 + s] = {
        notes: [midi(chord[k % chord.length] ?? chord[0])],
        len: 1,
        vel: s % 4 === 0 ? Math.min(1, vel + 0.18) : vel,
        accent: s % 4 === 0,
      };
      k += 1;
    }
  });
  return target;
}

const FOUR = "x...x...x...x...";
const CLAP = "....X.......X...";
const CLAP_FILL = "....X.....x.X.x.";
const HAT_8 = "X.x.X.x.X.x.X.x.";
const OPEN_AND = "..........x.....";

const AM = ["A4", "C5", "E5"];
const FMAJ = ["F4", "A4", "C5"];
const EMIN = ["E4", "G4", "B4"];
const AM7 = ["A3", "C4", "E4", "G4"];
const FMAJ7 = ["F3", "A3", "C4", "E4"];
const EMIN7 = ["E3", "G3", "B3", "D4"];

const warehouse: Track = {
  id: "warehouse",
  name: "Warehouse",
  detail: "126 house",
  kind: "house",
  bpm: 126,
  swing: 0.22,
  mix: { ...BASE_MIX },
  kick: drums(bars([FOUR, FOUR, FOUR, "x...x...x...x.x."]), 1, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, CLAP_FILL]), 0.62, 0.95),
  hat: drums(bars([HAT_8, HAT_8, HAT_8, HAT_8]), 0.4, 0.72),
  hatOpen: drums(bars([OPEN_AND, OPEN_AND, OPEN_AND, OPEN_AND]), 0.55, 0.55),
  bass: pumpingBass([
    ["A2", "A2", "C3", "A2"],
    ["A2", "G2", "A2", "E2"],
    ["C3", "A2", "E3", "C3"],
    ["G2", "A2", "E2", "G2"],
  ]),
  stab: paint([
    [0, 7, AM, 1, 0.55],
    [0, 15, AM, 1, 0.48],
    [1, 7, AM, 1, 0.55],
    [1, 15, FMAJ, 1, 0.5],
    [2, 7, FMAJ, 1, 0.55],
    [2, 15, EMIN, 1, 0.5],
    [3, 7, EMIN, 1, 0.5],
    [3, 15, AM, 1, 0.58],
  ]),
  lead: paint([
    [0, 4, "C5", 6, 0.52],
    [0, 12, "E4", 3, 0.46],
    [1, 2, "A4", 8, 0.5],
    [2, 4, "A4", 4, 0.48],
    [2, 10, "C5", 4, 0.52],
    [3, 0, "B4", 4, 0.46],
    [3, 8, "A4", 6, 0.52],
  ]),
  pad: paint([
    [0, 0, AM7, 32, 0.55],
    [2, 0, FMAJ7, 16, 0.5],
    [3, 0, EMIN7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["A4", "C5", "E5", "C5"],
      ["A4", "C5", "E5", "G4"],
      ["F4", "A4", "C5", "A4"],
      ["E4", "G4", "B4", "G4"],
    ],
    1,
    0.42,
  ),
};

const DM7 = ["D3", "F3", "A3", "C4"];
const BBMAJ7 = ["Bb2", "D3", "F3", "A3"];
const CMAJ7 = ["C3", "E3", "G3", "B3"];
const DM = ["D4", "F4", "A4"];
const BB = ["Bb3", "D4", "F4"];
const FCH = ["F4", "A4", "C5"];
const CCH = ["C4", "E4", "G4"];

const drive: Track = {
  id: "drive",
  name: "Night Drive",
  detail: "116 deep",
  kind: "deep",
  bpm: 116,
  swing: 0.12,
  mix: {
    ...BASE_MIX,
    clap: 0.4,
    hats: 0.22,
    bass: 0.86,
    stab: 0.32,
    lead: 0.42,
    pad: 0.46,
    arp: 0.26,
  },
  kick: drums(bars([FOUR, FOUR, FOUR, FOUR]), 1, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, CLAP]), 0.5, 0.78),
  hat: drums(bars(["X...x...X...x...", "X...x...X...x...", "X...x...X...x...", "X...x...X...x..."]), 0.4, 0.66),
  hatOpen: drums(bars(["..............x.", "..............x.", "..............x.", "..............x."]), 0.42, 0.42),
  bass: paint([
    [0, 0, "D2", 6, 0.9],
    [0, 8, "F2", 4, 0.82],
    [0, 12, "A2", 3, 0.78],
    [1, 0, "Bb2", 6, 0.88],
    [1, 8, "D2", 4, 0.8],
    [1, 12, "F2", 3, 0.76],
    [2, 0, "F2", 7, 0.9],
    [2, 8, "C2", 6, 0.84],
    [3, 0, "C2", 4, 0.86],
    [3, 8, "G2", 4, 0.8],
    [3, 12, "A2", 3, 0.9],
  ]),
  stab: paint([
    [0, 4, DM, 2, 0.4],
    [0, 12, DM, 2, 0.36],
    [1, 4, BB, 2, 0.4],
    [1, 12, BB, 2, 0.36],
    [2, 4, FCH, 2, 0.4],
    [2, 12, FCH, 2, 0.36],
    [3, 4, CCH, 2, 0.42],
    [3, 12, CCH, 2, 0.36],
  ]),
  lead: paint([
    [0, 8, "A4", 8, 0.46],
    [1, 4, "F4", 6, 0.42],
    [2, 4, "C5", 8, 0.48],
    [3, 6, "D4", 8, 0.46],
  ]),
  pad: paint([
    [0, 0, DM7, 16, 0.6],
    [1, 0, BBMAJ7, 16, 0.55],
    [2, 0, FMAJ7, 16, 0.55],
    [3, 0, CMAJ7, 16, 0.58],
  ]),
  arp: arpCycle(
    [
      ["D4", "F4", "A4", "C5"],
      ["Bb3", "D4", "F4", "A4"],
      ["F4", "A4", "C5", "E5"],
      ["C4", "E4", "G4", "B4"],
    ],
    2,
    0.4,
  ),
};

const acid: Track = {
  id: "acid",
  name: "Acid Line",
  detail: "134 303",
  kind: "acid",
  bpm: 134,
  swing: 0,
  mix: {
    ...BASE_MIX,
    kick: 0.88,
    clap: 0.42,
    hats: 0.4,
    bass: 0.9,
    stab: 0.24,
    lead: 0.2,
    pad: 0.16,
    arp: 0.22,
  },
  kick: drums(bars([FOUR, FOUR, FOUR, FOUR]), 1, 1),
  clap: drums(bars(["....X...........", "....X.......X...", "....X...........", "....X.......X..."]), 0.5, 0.88),
  hat: drums(bars(["XxxxXxxxXxxxXxxx", "XxxxXxxxXxxxXxxx", "XxxxXxxxXxxxXxxx", "XxxxXxxxXxxxXxxx"]), 0.26, 0.5),
  hatOpen: drums(bars(["..x...x...x...x.", "..x...x...x...x.", "..x...x...x...x.", "..x...x...x...x."]), 0.36, 0.36),
  bass: paint([
    [0, 0, "A2", 1, 0.95, true],
    [0, 1, "A2", 1, 0.7],
    [0, 3, "C3", 1, 0.75],
    [0, 5, "A2", 1, 0.72],
    [0, 7, "E2", 1, 0.7],
    [0, 9, "G2", 1, 0.74],
    [0, 10, "A2", 1, 0.95, true],
    [0, 12, "C3", 1, 0.78],
    [0, 13, "D3", 1, 0.8],
    [0, 14, "C3", 1, 0.92, true],
    [0, 15, "A2", 1, 0.7],
    [1, 0, "A2", 1, 0.8],
    [1, 2, "C3", 1, 0.95, true],
    [1, 3, "C3", 1, 0.72],
    [1, 4, "E3", 1, 0.84],
    [1, 6, "D3", 1, 0.76],
    [1, 7, "C3", 1, 0.7],
    [1, 8, "A2", 1, 0.95, true],
    [1, 9, "G2", 1, 0.7],
    [1, 11, "A2", 1, 0.78],
    [1, 13, "E2", 1, 0.72],
    [1, 14, "G2", 1, 0.9, true],
    [2, 0, "A2", 1, 0.95, true],
    [2, 1, "A2", 1, 0.7],
    [2, 3, "C3", 1, 0.8],
    [2, 5, "A2", 1, 0.72],
    [2, 7, "E2", 1, 0.7],
    [2, 9, "G2", 1, 0.78],
    [2, 10, "A2", 1, 0.96, true],
    [2, 12, "C3", 1, 0.8],
    [2, 13, "D3", 1, 0.84],
    [2, 14, "E3", 1, 0.94, true],
    [2, 15, "C3", 1, 0.72],
    [3, 0, "A2", 1, 0.88, true],
    [3, 2, "C3", 1, 0.8],
    [3, 3, "D3", 1, 0.76],
    [3, 4, "E3", 1, 0.9, true],
    [3, 6, "D3", 1, 0.74],
    [3, 7, "C3", 1, 0.7],
    [3, 8, "A2", 1, 0.95, true],
    [3, 10, "G2", 1, 0.78],
    [3, 11, "A2", 1, 0.8],
    [3, 13, "E2", 1, 0.72],
    [3, 14, "A2", 1, 0.92, true],
  ]),
  stab: paint([
    [0, 6, AM, 1, 0.4, true],
    [0, 14, ["E4", "A4", "C5"], 1, 0.32],
    [1, 6, AM, 1, 0.4, true],
    [1, 14, ["E4", "A4", "C5"], 1, 0.32],
    [2, 6, AM, 1, 0.45, true],
    [2, 14, ["G4", "B4", "D5"], 1, 0.34],
    [3, 6, ["G4", "C5", "E5"], 1, 0.42, true],
    [3, 14, AM, 1, 0.36],
  ]),
  lead: paint([
    [0, 4, "E4", 4, 0.36],
    [1, 8, "C5", 4, 0.32],
    [2, 4, "B4", 6, 0.36],
    [3, 8, "A4", 6, 0.38],
  ]),
  pad: paint([[0, 0, ["A2", "E3"], 64, 0.45]]),
  arp: paint(
    [0, 1, 2, 3].flatMap((bar) => {
      const pitches = ["A5", "C6", "E6", "G5", "E6", "C6"];
      const steps = [0, 3, 6, 10, 12, 15];
      return steps.map((step, i) => [bar, step, pitches[i] ?? "A5", 1, i % 2 === 0 ? 0.42 : 0.3] as [number, number, string, number, number]);
    }),
  ),
};

const FM = ["F4", "Ab4", "C5"];
const AB = ["Ab4", "C5", "Eb5"];
const EB = ["Eb4", "G4", "Bb4"];
const BBMAJ = ["Bb4", "D5", "F5"];
const FM7 = ["F3", "Ab3", "C4", "Eb4"];
const ABMAJ7 = ["Ab3", "C4", "Eb4", "G4"];
const EBMAJ7 = ["Eb3", "G3", "Bb3", "D4"];
const BB7 = ["Bb2", "D3", "F3", "Ab3"];

const basement: Track = {
  id: "basement",
  name: "Basement",
  detail: "122 jack",
  kind: "house",
  bpm: 122,
  swing: 0.3,
  mix: {
    ...BASE_MIX,
    clap: 0.58,
    hats: 0.42,
    bass: 0.84,
    stab: 0.46,
    lead: 0.4,
    arp: 0.28,
  },
  kick: drums(bars([FOUR, FOUR, "x...x...x.x.x...", FOUR]), 1, 1),
  clap: drums(bars([CLAP, CLAP, "....X...........", CLAP_FILL]), 0.55, 0.92),
  hat: drums(bars(["X.xxX.x.X.xxX.x.", "X.xxX.x.X.xxX.x.", "X.xxX.x.X.xxX.x.", "X.xxX.x.X.xxX.x."]), 0.38, 0.7),
  hatOpen: drums(bars([OPEN_AND, OPEN_AND, OPEN_AND, "......x...x....."]), 0.5, 0.5),
  bass: pumpingBass([
    ["F2", "F2", "Ab2", "F2"],
    ["Ab2", "C3", "Ab2", "Eb2"],
    ["Eb2", "G2", "Bb2", "G2"],
    ["C2", "Bb2", "Ab2", "F2"],
  ]),
  stab: paint([
    [0, 7, FM, 1, 0.58],
    [0, 15, FM, 1, 0.48],
    [1, 7, AB, 1, 0.56],
    [1, 15, AB, 1, 0.46],
    [2, 7, EB, 1, 0.56],
    [2, 15, BBMAJ, 1, 0.5],
    [3, 7, BBMAJ, 1, 0.52],
    [3, 15, FM, 1, 0.6],
  ]),
  lead: paint([
    [0, 4, "C5", 6, 0.48],
    [1, 4, "Eb5", 6, 0.5],
    [2, 2, "Bb4", 8, 0.46],
    [3, 4, "Ab4", 8, 0.5],
  ]),
  pad: paint([
    [0, 0, FM7, 16, 0.52],
    [1, 0, ABMAJ7, 16, 0.48],
    [2, 0, EBMAJ7, 16, 0.5],
    [3, 0, BB7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["F4", "Ab4", "C5", "Eb5"],
      ["Ab4", "C5", "Eb5", "G5"],
      ["Eb4", "G4", "Bb4", "D5"],
      ["Bb4", "D5", "F5", "Ab5"],
    ],
    2,
    0.4,
  ),
};

const EM = ["E4", "G4", "B4"];
const GMAJ = ["G4", "B4", "D5"];
const DMAJ = ["D4", "F#4", "A4"];
const EM7 = ["E3", "G3", "B3", "D4"];
const GMAJ7 = ["G3", "B3", "D4", "F#4"];
const DMAJ7 = ["D3", "F#3", "A3", "C#4"];

const glass: Track = {
  id: "glass",
  name: "Glass",
  detail: "110 glow",
  kind: "deep",
  bpm: 110,
  swing: 0.08,
  mix: {
    ...BASE_MIX,
    kick: 0.86,
    clap: 0.36,
    hats: 0.18,
    bass: 0.82,
    stab: 0.3,
    lead: 0.48,
    pad: 0.5,
    arp: 0.24,
  },
  kick: drums(bars([FOUR, FOUR, FOUR, FOUR]), 1, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, CLAP]), 0.42, 0.7),
  hat: drums(bars(["X.......x.......", "X.......x.......", "X.......x.......", "X...x...x...x..."]), 0.36, 0.6),
  hatOpen: drums(bars(["..............x.", "..............x.", "..............x.", "..........x....."]), 0.4, 0.4),
  bass: paint([
    [0, 0, "E2", 8, 0.9],
    [0, 8, "B2", 6, 0.8],
    [1, 0, "C2", 8, 0.88],
    [1, 8, "G2", 6, 0.78],
    [2, 0, "G2", 6, 0.88],
    [2, 8, "D2", 6, 0.8],
    [3, 0, "B2", 4, 0.86],
    [3, 8, "E2", 6, 0.9],
  ]),
  stab: paint([
    [0, 4, EM, 2, 0.38],
    [0, 12, EM, 2, 0.32],
    [1, 4, CCH, 2, 0.38],
    [1, 12, CCH, 2, 0.32],
    [2, 4, GMAJ, 2, 0.4],
    [2, 12, GMAJ, 2, 0.34],
    [3, 4, DMAJ, 2, 0.4],
    [3, 12, EM, 2, 0.36],
  ]),
  lead: paint([
    [0, 6, "B4", 8, 0.46],
    [1, 4, "G4", 8, 0.44],
    [2, 4, "D5", 6, 0.48],
    [3, 6, "E4", 8, 0.46],
  ]),
  pad: paint([
    [0, 0, EM7, 16, 0.58],
    [1, 0, CMAJ7, 16, 0.52],
    [2, 0, GMAJ7, 16, 0.55],
    [3, 0, DMAJ7, 16, 0.56],
  ]),
  arp: arpCycle(
    [
      ["E4", "G4", "B4", "D5"],
      ["C4", "E4", "G4", "B4"],
      ["G4", "B4", "D5", "F#5"],
      ["D4", "F#4", "A4", "C#5"],
    ],
    2,
    0.36,
  ),
};

const GM = ["G4", "Bb4", "D5"];
const GM7 = ["G3", "Bb3", "D4", "F4"];
const BBHIGH = ["Bb3", "D4", "F4", "A4"];

const tunnel: Track = {
  id: "tunnel",
  name: "Tunnel",
  detail: "128 peak",
  kind: "house",
  bpm: 128,
  swing: 0.14,
  mix: {
    ...BASE_MIX,
    hats: 0.4,
    bass: 0.86,
    stab: 0.42,
    lead: 0.46,
    pad: 0.26,
    arp: 0.3,
  },
  kick: drums(bars([FOUR, FOUR, FOUR, "x...x...x...xx.."]), 1, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, CLAP_FILL]), 0.58, 0.94),
  hat: drums(bars(["X.xxX.xxX.xxX.xx", "X.xxX.xxX.xxX.xx", "X.xxX.xxX.xxX.xx", "X.xxX.xxX.xxX.xx"]), 0.36, 0.68),
  hatOpen: drums(bars(["......x.......x.", "......x.......x.", "......x.......x.", "......x...x...x."]), 0.52, 0.52),
  bass: pumpingBass([
    ["G2", "G2", "Bb2", "G2"],
    ["Eb2", "Eb2", "G2", "Bb2"],
    ["Bb2", "Bb2", "D3", "Bb2"],
    ["F2", "A2", "G2", "D2"],
  ]),
  stab: paint([
    [0, 6, GM, 1, 0.56],
    [0, 14, GM, 1, 0.46],
    [1, 6, EB, 1, 0.54],
    [1, 14, EB, 1, 0.46],
    [2, 6, BBMAJ, 1, 0.54],
    [2, 14, BBMAJ, 1, 0.48],
    [3, 6, FCH, 1, 0.52],
    [3, 14, GM, 1, 0.58],
  ]),
  lead: paint([
    [0, 4, "Bb4", 6, 0.48],
    [1, 2, "G4", 8, 0.46],
    [2, 4, "D5", 6, 0.5],
    [3, 4, "C5", 8, 0.48],
  ]),
  pad: paint([
    [0, 0, GM7, 16, 0.5],
    [1, 0, EBMAJ7, 16, 0.46],
    [2, 0, BBHIGH, 16, 0.48],
    [3, 0, FMAJ7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["G4", "Bb4", "D5", "F5"],
      ["Eb4", "G4", "Bb4", "D5"],
      ["Bb4", "D5", "F5", "A5"],
      ["F4", "A4", "C5", "D5"],
    ],
    2,
    0.4,
  ),
};

const LOFI_MIX: Mix = {
  kick: 0.72,
  clap: 0.44,
  hats: 0.3,
  bass: 0.68,
  stab: 0.46,
  lead: 0.4,
  pad: 0.52,
  arp: 0.28,
};

const BOOM = "x.......x..x....";
const BOOM_B = "x..x......x.....";
const BOOM_C = "x.........x.....";
const HAT_LO = "x.x.x.x.x.x.x.x.";
const HAT_LAZY = "....x.......x...";
const OPEN_LO = "..............x.";
const E7 = ["E3", "G#3", "B3", "D4"];
const G7 = ["G3", "B3", "D4", "F4"];
const GM7LO = ["G3", "Bb3", "D4", "F4"];

const rain: Track = {
  id: "rain",
  name: "Rain",
  detail: "84 dust",
  kind: "lofi",
  bpm: 84,
  swing: 0.52,
  mix: { ...LOFI_MIX },
  kick: drums(bars([BOOM, BOOM, BOOM, "x.......x.x.x..."]), 0.9, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, "....X....x..X..."]), 0.45, 0.8),
  hat: drums(bars([HAT_LO, HAT_LO, HAT_LO, HAT_LO]), 0.32, 0.5),
  hatOpen: drums(bars([OPEN_LO, OPEN_LO, OPEN_LO, OPEN_LO]), 0.28, 0.28),
  bass: paint([
    [0, 0, "A2", 8, 0.8],
    [0, 8, "C3", 6, 0.7],
    [1, 0, "D2", 8, 0.78],
    [1, 10, "E2", 4, 0.68],
    [2, 0, "F2", 8, 0.8],
    [2, 8, "E2", 6, 0.7],
    [3, 0, "E2", 4, 0.76],
    [3, 8, "A2", 6, 0.82],
  ]),
  stab: paint([
    [0, 4, AM, 3, 0.42],
    [0, 12, AM, 2, 0.32],
    [1, 4, ["D4", "F4", "A4"], 3, 0.4],
    [1, 12, ["D4", "F4", "A4"], 2, 0.3],
    [2, 4, FMAJ, 3, 0.42],
    [2, 12, FMAJ, 2, 0.32],
    [3, 4, ["E4", "G#4", "B4"], 3, 0.4],
    [3, 12, AM, 2, 0.36],
  ]),
  lead: paint([
    [0, 8, "C5", 6, 0.4],
    [1, 4, "A4", 8, 0.38],
    [2, 4, "F4", 6, 0.4],
    [3, 8, "E4", 6, 0.42],
  ]),
  pad: paint([
    [0, 0, AM7, 16, 0.55],
    [1, 0, DM7, 16, 0.5],
    [2, 0, FMAJ7, 16, 0.52],
    [3, 0, E7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["A4", "C5", "E5", "G4"],
      ["D4", "F4", "A4", "C5"],
      ["F4", "A4", "C5", "E5"],
      ["E4", "G#4", "B4", "D5"],
    ],
    4,
    0.32,
  ),
};

const study: Track = {
  id: "study",
  name: "Study",
  detail: "76 page",
  kind: "lofi",
  bpm: 76,
  swing: 0.58,
  mix: { ...LOFI_MIX, hats: 0.14, pad: 0.58, lead: 0.3 },
  kick: drums(bars([BOOM_C, BOOM_C, BOOM_C, "x.........x..x.."]), 0.86, 1),
  clap: drums(bars([CLAP, CLAP, "....X...........", CLAP]), 0.4, 0.72),
  hat: drums(bars([HAT_LAZY, HAT_LAZY, HAT_LO, HAT_LAZY]), 0.28, 0.42),
  hatOpen: drums(bars(["................", "..............x.", "................", "..............x."]), 0.22, 0.22),
  bass: paint([
    [0, 0, "D2", 10, 0.78],
    [1, 0, "G2", 8, 0.74],
    [1, 10, "A2", 4, 0.66],
    [2, 0, "C2", 10, 0.76],
    [3, 0, "A2", 6, 0.74],
    [3, 8, "D2", 6, 0.8],
  ]),
  stab: paint([
    [0, 6, DM, 4, 0.36],
    [1, 6, ["G4", "Bb4", "D5"], 4, 0.34],
    [2, 6, CCH, 4, 0.36],
    [3, 6, ["A4", "C5", "E5"], 3, 0.32],
  ]),
  lead: paint([
    [0, 4, "A4", 8, 0.36],
    [1, 8, "F4", 6, 0.34],
    [2, 4, "E4", 8, 0.36],
    [3, 8, "D4", 6, 0.38],
  ]),
  pad: paint([
    [0, 0, DM7, 16, 0.58],
    [1, 0, GM7LO, 16, 0.52],
    [2, 0, CMAJ7, 16, 0.54],
    [3, 0, AM7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["D4", "F4", "A4", "C5"],
      ["G3", "Bb3", "D4", "F4"],
      ["C4", "E4", "G4", "B4"],
      ["A3", "C4", "E4", "G4"],
    ],
    4,
    0.28,
  ),
};

const porch: Track = {
  id: "porch",
  name: "Porch",
  detail: "92 sun",
  kind: "lofi",
  bpm: 92,
  swing: 0.36,
  mix: { ...LOFI_MIX, hats: 0.24, stab: 0.48 },
  kick: drums(bars([BOOM_B, BOOM_B, BOOM, BOOM_B]), 0.88, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, CLAP_FILL]), 0.42, 0.78),
  hat: drums(bars([HAT_LO, HAT_LO, HAT_LO, HAT_LO]), 0.34, 0.52),
  hatOpen: drums(bars([OPEN_AND, OPEN_AND, OPEN_AND, "......x.......x."]), 0.3, 0.3),
  bass: paint([
    [0, 0, "F2", 6, 0.8],
    [0, 8, "A2", 6, 0.7],
    [1, 0, "Bb2", 8, 0.78],
    [1, 10, "D3", 4, 0.68],
    [2, 0, "C2", 6, 0.76],
    [2, 8, "E2", 6, 0.7],
    [3, 0, "F2", 4, 0.8],
    [3, 8, "C2", 6, 0.74],
  ]),
  stab: paint([
    [0, 4, FCH, 3, 0.46],
    [0, 12, FCH, 2, 0.34],
    [1, 4, BB, 3, 0.44],
    [1, 12, BB, 2, 0.32],
    [2, 4, CCH, 3, 0.44],
    [2, 12, CCH, 2, 0.32],
    [3, 4, FCH, 3, 0.48],
    [3, 12, AM, 2, 0.34],
  ]),
  lead: paint([
    [0, 4, "A4", 6, 0.4],
    [1, 2, "F4", 8, 0.42],
    [2, 6, "E4", 6, 0.4],
    [3, 4, "C5", 8, 0.44],
  ]),
  pad: paint([
    [0, 0, FMAJ7, 16, 0.54],
    [1, 0, BBHIGH, 16, 0.5],
    [2, 0, CMAJ7, 16, 0.52],
    [3, 0, AM7, 16, 0.48],
  ]),
  arp: arpCycle(
    [
      ["F4", "A4", "C5", "E5"],
      ["Bb3", "D4", "F4", "A4"],
      ["C4", "E4", "G4", "B4"],
      ["A3", "C4", "E4", "G4"],
    ],
    4,
    0.3,
  ),
};

const tape: Track = {
  id: "tape",
  name: "Tape",
  detail: "80 hiss",
  kind: "lofi",
  bpm: 80,
  swing: 0.5,
  mix: { ...LOFI_MIX, pad: 0.6, arp: 0.22 },
  kick: drums(bars([BOOM, BOOM_C, BOOM, "x..x....x..x...."]), 0.84, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, "....X....x..X.x."]), 0.4, 0.74),
  hat: drums(bars([HAT_LO, HAT_LAZY, HAT_LO, HAT_LO]), 0.3, 0.46),
  hatOpen: drums(bars([OPEN_LO, "................", OPEN_LO, OPEN_LO]), 0.24, 0.24),
  bass: paint([
    [0, 0, "C2", 8, 0.78],
    [0, 10, "E2", 4, 0.66],
    [1, 0, "A2", 8, 0.76],
    [1, 10, "G2", 4, 0.68],
    [2, 0, "D2", 10, 0.78],
    [3, 0, "G2", 6, 0.74],
    [3, 8, "C2", 6, 0.8],
  ]),
  stab: paint([
    [0, 4, CCH, 4, 0.38],
    [1, 4, AM, 4, 0.36],
    [2, 4, DM, 4, 0.38],
    [3, 4, ["G4", "B4", "D5"], 3, 0.34],
    [3, 12, CCH, 2, 0.3],
  ]),
  lead: paint([
    [0, 6, "G4", 8, 0.38],
    [1, 4, "E4", 8, 0.4],
    [2, 4, "A4", 8, 0.4],
    [3, 8, "B4", 6, 0.38],
  ]),
  pad: paint([
    [0, 0, CMAJ7, 16, 0.56],
    [1, 0, AM7, 16, 0.52],
    [2, 0, DM7, 16, 0.54],
    [3, 0, G7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["C4", "E4", "G4", "B4"],
      ["A3", "C4", "E4", "G4"],
      ["D4", "F4", "A4", "C5"],
      ["G3", "B3", "D4", "F4"],
    ],
    4,
    0.28,
  ),
};

const nightbus: Track = {
  id: "nightbus",
  name: "Nightbus",
  detail: "88 ride",
  kind: "lofi",
  bpm: 88,
  swing: 0.44,
  mix: { ...LOFI_MIX, bass: 0.74, lead: 0.4 },
  kick: drums(bars([BOOM_B, BOOM, BOOM_B, BOOM]), 0.9, 1),
  clap: drums(bars([CLAP, CLAP, CLAP, CLAP]), 0.42, 0.76),
  hat: drums(bars([HAT_LO, HAT_LO, HAT_LO, "x.x.x.x.x.x.x.X."]), 0.32, 0.5),
  hatOpen: drums(bars([OPEN_LO, OPEN_LO, OPEN_LO, "......x.......x."]), 0.26, 0.26),
  bass: paint([
    [0, 0, "E2", 8, 0.8],
    [0, 8, "B2", 6, 0.7],
    [1, 0, "C2", 8, 0.78],
    [1, 10, "G2", 4, 0.68],
    [2, 0, "G2", 6, 0.78],
    [2, 8, "D2", 6, 0.7],
    [3, 0, "B2", 4, 0.74],
    [3, 8, "E2", 6, 0.82],
  ]),
  stab: paint([
    [0, 4, EM, 3, 0.4],
    [0, 12, EM, 2, 0.3],
    [1, 4, CCH, 3, 0.38],
    [1, 12, CCH, 2, 0.3],
    [2, 4, GMAJ, 3, 0.4],
    [2, 12, GMAJ, 2, 0.3],
    [3, 4, DMAJ, 3, 0.38],
    [3, 12, EM, 2, 0.34],
  ]),
  lead: paint([
    [0, 8, "B4", 6, 0.4],
    [1, 2, "G4", 8, 0.42],
    [2, 4, "D5", 6, 0.4],
    [3, 8, "E4", 6, 0.42],
  ]),
  pad: paint([
    [0, 0, EM7, 16, 0.55],
    [1, 0, CMAJ7, 16, 0.5],
    [2, 0, GMAJ7, 16, 0.52],
    [3, 0, DMAJ7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["E4", "G4", "B4", "D5"],
      ["C4", "E4", "G4", "B4"],
      ["G4", "B4", "D5", "F#5"],
      ["D4", "F#4", "A4", "C#5"],
    ],
    4,
    0.3,
  ),
};

const kettle: Track = {
  id: "kettle",
  name: "Kettle",
  detail: "74 steam",
  kind: "lofi",
  bpm: 74,
  swing: 0.62,
  mix: { ...LOFI_MIX, kick: 0.66, hats: 0.12, pad: 0.62, arp: 0.14 },
  kick: drums(bars([BOOM_C, BOOM_C, "x...............", BOOM_C]), 0.82, 1),
  clap: drums(bars([CLAP, "....X...........", CLAP, "....X.......X..."]), 0.36, 0.66),
  hat: drums(bars([HAT_LAZY, HAT_LAZY, HAT_LAZY, HAT_LO]), 0.26, 0.4),
  hatOpen: drums(bars(["................", OPEN_LO, "................", OPEN_LO]), 0.2, 0.2),
  bass: paint([
    [0, 0, "Bb2", 12, 0.76],
    [1, 0, "Eb2", 10, 0.74],
    [2, 0, "G2", 8, 0.72],
    [2, 10, "F2", 4, 0.66],
    [3, 0, "F2", 6, 0.74],
    [3, 8, "Bb2", 6, 0.8],
  ]),
  stab: paint([
    [0, 8, BB, 4, 0.34],
    [1, 8, EB, 4, 0.32],
    [2, 8, ["G4", "Bb4", "D5"], 4, 0.34],
    [3, 4, FCH, 4, 0.32],
  ]),
  lead: paint([
    [0, 4, "D4", 8, 0.34],
    [1, 6, "Bb4", 8, 0.34],
    [2, 4, "C5", 8, 0.36],
    [3, 8, "A4", 6, 0.36],
  ]),
  pad: paint([
    [0, 0, BBHIGH, 16, 0.58],
    [1, 0, EBMAJ7, 16, 0.54],
    [2, 0, GM7LO, 16, 0.52],
    [3, 0, FMAJ7, 16, 0.5],
  ]),
  arp: arpCycle(
    [
      ["Bb3", "D4", "F4", "A4"],
      ["Eb4", "G4", "Bb4", "D5"],
      ["G3", "Bb3", "D4", "F4"],
      ["F3", "A3", "C4", "E4"],
    ],
    4,
    0.26,
  ),
};

export const TRACKS: Track[] = [warehouse, drive, acid, basement, glass, tunnel, rain, study, porch, tape, nightbus, kettle].map(arrange);


function arrange(track: Track): Track {
  const phrase: Phrase = {
    kick: track.kick,
    clap: track.clap,
    hat: track.hat,
    hatOpen: track.hatOpen,
    bass: track.bass,
    stab: track.stab,
    lead: track.lead,
    pad: track.pad,
    arp: track.arp,
  };
  for (const [key, value] of Object.entries(phrase)) {
    if (value.length !== PHRASE) throw new Error(`${track.id} ${key} ${value.length}`);
  }
  const song = form(phrase, track.kind === "acid");
  return { ...track, ...song };
}

type Phrase = {
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

function form(groove: Phrase, acid: boolean): Phrase {
  const quiet = zeros(PHRASE);
  const empty = blanks(PHRASE);
  const intro: Phrase = {
    kick: groove.kick.slice(),
    clap: muteNum(groove.clap, [3]),
    hat: groove.hat.slice(),
    hatOpen: quiet.slice(),
    bass: muteNote(groove.bass, [2, 3]),
    stab: empty.slice(),
    lead: empty.slice(),
    pad: copyNote(groove.pad),
    arp: empty.slice(),
  };
  const breakKick = quiet.slice();
  breakKick[60] = 1;
  breakKick[62] = 0.72;
  breakKick[63] = 1;
  const dropped: Phrase = {
    kick: breakKick,
    clap: quiet.slice(),
    hat: groove.hat.slice(),
    hatOpen: groove.hatOpen.slice(),
    bass: acid ? copyNote(groove.bass) : muteNote(groove.bass, [3]),
    stab: copyNote(groove.stab),
    lead: copyNote(groove.lead),
    pad: copyNote(groove.pad),
    arp: copyNote(groove.arp),
  };
  const dropKick = groove.kick.slice();
  dropKick[14] = Math.max(dropKick[14] ?? 0, 0.7);
  const drop: Phrase = {
    kick: dropKick,
    clap: groove.clap.slice(),
    hat: groove.hat.slice(),
    hatOpen: groove.hatOpen.slice(),
    bass: copyNote(groove.bass),
    stab: copyNote(groove.stab),
    lead: copyNote(groove.lead),
    pad: copyNote(groove.pad),
    arp: copyNote(groove.arp),
  };
  const grooveCopy: Phrase = {
    kick: groove.kick.slice(),
    clap: groove.clap.slice(),
    hat: groove.hat.slice(),
    hatOpen: groove.hatOpen.slice(),
    bass: copyNote(groove.bass),
    stab: copyNote(groove.stab),
    lead: copyNote(groove.lead),
    pad: copyNote(groove.pad),
    arp: copyNote(groove.arp),
  };
  return {
    kick: joinNum(intro.kick, grooveCopy.kick, dropped.kick, drop.kick),
    clap: joinNum(intro.clap, grooveCopy.clap, dropped.clap, drop.clap),
    hat: joinNum(intro.hat, grooveCopy.hat, dropped.hat, drop.hat),
    hatOpen: joinNum(intro.hatOpen, grooveCopy.hatOpen, dropped.hatOpen, drop.hatOpen),
    bass: joinNote(intro.bass, grooveCopy.bass, dropped.bass, drop.bass),
    stab: joinNote(intro.stab, grooveCopy.stab, dropped.stab, drop.stab),
    lead: joinNote(intro.lead, grooveCopy.lead, dropped.lead, drop.lead),
    pad: joinNote(intro.pad, grooveCopy.pad, dropped.pad, drop.pad),
    arp: joinNote(intro.arp, grooveCopy.arp, dropped.arp, drop.arp),
  };
}

function muteNum(src: number[], keep: number[]): number[] {
  const allow = new Set(keep);
  return src.map((value, index) => (allow.has(Math.floor(index / 16)) ? value : 0));
}

function muteNote(src: (NoteEvent | null)[], keep: number[]): (NoteEvent | null)[] {
  const allow = new Set(keep);
  return src.map((value, index) => (allow.has(Math.floor(index / 16)) ? value : null));
}

function copyNote(src: (NoteEvent | null)[]): (NoteEvent | null)[] {
  return src.map((event) => (event ? { ...event, notes: [...event.notes] } : null));
}

function joinNum(...parts: number[][]): number[] {
  const out = parts.flat();
  if (out.length !== STEPS) throw new Error(`join drums ${out.length}`);
  return out;
}

function joinNote(...parts: (NoteEvent | null)[][]): (NoteEvent | null)[] {
  const out = parts.flat();
  if (out.length !== STEPS) throw new Error(`join notes ${out.length}`);
  return out;
}

export function barActivity(track: Track, id: StemId, bar: number): boolean[] {
  const on = Array.from({ length: 16 }, () => false);
  const start = bar * 16;
  for (let i = 0; i < 16; i += 1) {
    const at = start + i;
    if (id === "kick") on[i] = track.kick[at] > 0;
    else if (id === "clap") on[i] = track.clap[at] > 0;
    else if (id === "hats") on[i] = track.hat[at] > 0 || track.hatOpen[at] > 0;
    else if (id === "bass") on[i] = track.bass[at] != null;
    else if (id === "stab") on[i] = track.stab[at] != null;
    else if (id === "lead") on[i] = track.lead[at] != null;
    else if (id === "pad") on[i] = track.pad[at] != null;
    else on[i] = track.arp[at] != null;
  }
  return on;
}

export function emptyMutes(): Record<StemId, boolean> {
  return {
    kick: false,
    clap: false,
    hats: false,
    bass: false,
    stab: false,
    lead: false,
    pad: false,
    arp: false,
  };
}
