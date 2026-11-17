// Building blocks for the PolinRider rule tests.
//
// devsweep scans its own repository in CI, and that scan reads these test files. So no test file
// holds a whole campaign string or a padded line: tests build them at run time, from pieces or by
// decoding the bundled marker list, and write them into temporary folders. Nothing here is real
// malware: every "payload" is a harmless console.log.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXED_MARKERS, type MarkerKind } from '../../src/checks/code/markers.js';

/** Appears in every fake payload, so tests can check that no output ever quotes it. */
export const CANARY = 'fixture-canary';

/** A harmless stand-in for the hidden loader. */
export const PAYLOAD = `console.log("${CANARY}");`;

/** Joins pieces of a campaign string, so the whole string never appears in this repository. */
export function joined(...pieces: string[]): string {
  return pieces.join('');
}

/** `n` spaces or tabs. */
export function pad(n: number, char: ' ' | '\t' = ' '): string {
  return char.repeat(n);
}

/** The decoded text of every bundled fixed marker, with its kind. */
export function fixedMarkers(): { kind: MarkerKind; text: string; line: number }[] {
  return FIXED_MARKERS.map((entry) => ({
    kind: entry.kind,
    text: Buffer.from(entry.hex, 'hex').toString('utf8'),
    line: entry.line,
  }));
}

/** The first bundled marker of a kind. */
export function markerOfKind(kind: MarkerKind): string {
  const found = fixedMarkers().find((m) => m.kind === kind);
  if (!found) throw new Error(`no marker of kind ${kind}`);
  return found.text;
}

/** Writes files under `root`, creating folders as needed. */
export async function create(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}
