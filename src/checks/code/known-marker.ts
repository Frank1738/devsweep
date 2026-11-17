import { count, plural } from '../../format.js';
import { createFinding, type Finding, type Rule } from '../../types.js';
import { FIXED_MARKERS, type MarkerKind, PATTERN_MARKERS, sourceOf } from './markers.js';
import { extensionOf, lineAndColumn } from './text.js';

export const knownMarker: Rule = {
  id: 'code/known-marker',
  title: 'Known PolinRider marker',
  severity: 'critical',
  hidesSource: true,
  description:
    'The file contains a string proven to come from the PolinRider malware campaign: an ' +
    'obfuscator marker, a campaign tag, an XOR key, a wallet address or another indicator ' +
    "published by the researchers who analysed it. Normal code doesn't contain these, so a match " +
    'means the file is very likely infected. The list comes from meSingh/polinrider-scanner (MIT ' +
    'license) and is bundled with devsweep, so it works offline. The campaign changes its ' +
    'markers every few weeks, so code/hidden-padding is what catches new variants. Markdown ' +
    'files are skipped, since security write-ups quote these strings.',
  remediation:
    "Don't build, run or open the project in your editor until it is cleaned. Remove the " +
    "injected code, check the file's git history for when and how it was added, and check the " +
    'other files that commit changed. If you built or ran the project, treat your machine as ' +
    'compromised: rotate tokens and passwords from a clean device. If the file is a security ' +
    'tool or a list of indicators, accept the finding in devsweep.config.json.',
};

/** Write-ups quote the markers, so Markdown files are left out. */
const SKIPPED_EXTENSIONS = new Set(['md']);

export function appliesTo(file: string): boolean {
  return !SKIPPED_EXTENSIONS.has(extensionOf(file));
}

interface Marker {
  kind: MarkerKind;
  source: string;
  find(text: string): number;
}

const FIXED_VALUES = FIXED_MARKERS.map((entry) => Buffer.from(entry.hex, 'hex').toString('utf8'));

/** Decoded once, when the module loads. */
const MARKERS: readonly Marker[] = [
  ...FIXED_MARKERS.map((entry, i) => {
    const value = FIXED_VALUES[i] as string;
    return {
      kind: entry.kind,
      source: sourceOf('strong.txt', entry.line),
      find: (text: string) => text.indexOf(value),
    };
  }),
  ...PATTERN_MARKERS.map((pattern) => ({
    kind: pattern.kind,
    source: sourceOf('strong-patterns.txt', pattern.line),
    find: (text: string) => {
      const { anchor } = pattern;
      for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + 1)) {
        const start = pattern.matchAt(text, at);
        if (start !== -1) return start;
      }
      return -1;
    },
  })),
];

/**
 * Every fixed marker and pattern anchor in one regex. A single pass over a clean file rules it
 * out, about three times faster than one indexOf per marker. Only files it matches are searched
 * marker by marker.
 */
const ANY_MARKER = new RegExp(
  [...FIXED_VALUES, ...PATTERN_MARKERS.map((pattern) => pattern.anchor)]
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
);

/**
 * One finding per file, at the first marker in it, naming how many other markers it holds.
 * Each marker is one indexOf over the text, so a file megabytes long stays quick.
 */
export function analyze(file: string, text: string): Finding[] {
  if (!ANY_MARKER.test(text)) return [];
  const found = MARKERS.flatMap((marker) => {
    const at = marker.find(text);
    return at === -1 ? [] : [{ marker, at }];
  });
  const first = found.reduce<(typeof found)[number] | undefined>(
    (best, next) => (best === undefined || next.at < best.at ? next : best),
    undefined,
  );
  if (!first) return [];

  const { line, column } = lineAndColumn(text, first.at);
  let message =
    `Contains a known PolinRider ${first.marker.kind} at column ${count(column)}, a string ` +
    "from the campaign's malware that normal code doesn't contain.";
  if (found.length > 1) {
    message += ` ${plural(found.length - 1, 'other known marker')} ${found.length === 2 ? 'is' : 'are'} in this file too.`;
  }
  message += ` Source: ${first.marker.source}`;

  return [
    createFinding(knownMarker, {
      file,
      at: { line, column },
      subject: first.marker.kind,
      message,
    }),
  ];
}
