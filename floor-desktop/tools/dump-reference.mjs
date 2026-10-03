/**
 * Dump every arranged track from the ORIGINAL TypeScript library as JSON.
 *
 * `original/src/lib/music.ts` is self-contained — it imports nothing — so Node can
 * import it directly with type stripping. That gives a reference derived from the
 * original source rather than from the PHP port, which is the only version of this
 * check worth having.
 *
 * Usage: node tools/dump-reference.mjs <path/to/music.ts> [output.json]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('usage: node tools/dump-reference.mjs <path/to/music.ts> [output.json]');
  process.exit(2);
}

// Node strips types from .ts directly, but the file must not resolve the project's
// tsconfig paths, so import a copy in a scratch directory.
const scratch = join(tmpdir(), `floor-reference-${Date.now()}.ts`);
writeFileSync(scratch, await import('node:fs').then((fs) => fs.readFileSync(sourcePath)));

const { TRACKS } = await import(pathToFileURL(scratch).href);

const out = {};
for (const track of TRACKS) {
  out[track.id] = {
    id: track.id,
    name: track.name,
    kind: track.kind,
    bpm: track.bpm,
    swing: track.swing,
    mix: track.mix,
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
}

const json = `${JSON.stringify(out)}\n`;

if (process.argv[3]) {
  writeFileSync(process.argv[3], json);
  console.error(`wrote ${Object.keys(out).length} tracks to ${process.argv[3]}`);
} else {
  process.stdout.write(json);
}