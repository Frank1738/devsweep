/*!
 * Known PolinRider markers for code/known-marker.
 *
 * The strings and patterns below come from meSingh/polinrider-scanner, files ioc/strong.txt and
 * ioc/strong-patterns.txt at commit 3073dfd3e702e362dab339a3e4bc30674e88725d, used under the MIT
 * license:
 *
 * MIT License
 *
 * Copyright (c) 2026 Mandeep Singh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Why the strings are stored as hex: devsweep scans its own repository, and antivirus and other
// scanners read devsweep's files too. Written out plainly, this list would make every copy of
// devsweep look infected. Hex keeps the source and the built bundles free of the markers, and
// decoding it takes one line. To read an entry: Buffer.from(hex, 'hex').toString().
//
// Which entries were kept: every PolinRider entry in strong.txt, except
// - three that strong.txt files under MicrosoftSystem64, a related but different malware
//   (two GitHub release accounts and one host), since findings name PolinRider;
// - three that contain another entry (the "8-" tag forms and the long form of an XOR key),
//   since the shorter entry already matches wherever the longer one would.
//
// To refresh the list: compare strong.txt at a newer commit with this file, add new entries with
// their line number, and update SOURCE_COMMIT. Each entry's `line` links to its source below.

/** What kind of marker an entry is. Shown in findings, and used to accept one in the config. */
export type MarkerKind =
  | 'obfuscator marker'
  | 'campaign tag'
  | 'XOR key'
  | 'blockchain address'
  | 'campaign id'
  | 'C2 host'
  | 'fake font command'
  | 'payload staging account'
  | 'stage 2 marker'
  | 'payload server';

export interface FixedMarker {
  kind: MarkerKind;
  /** The marker's text, as hex of its UTF-8 bytes. Matched exactly, with case. */
  hex: string;
  /** Its line in strong.txt. See sourceOf(). */
  line: number;
  /** Who first reported it, from the comment above it in strong.txt. */
  reported?: string;
}

export const SOURCE_COMMIT = '3073dfd3e702e362dab339a3e4bc30674e88725d';
const SOURCE_BASE = `https://github.com/meSingh/polinrider-scanner/blob/${SOURCE_COMMIT}/ioc/`;

/** A link to the line an entry came from. */
export function sourceOf(file: 'strong.txt' | 'strong-patterns.txt', line: number): string {
  return `${SOURCE_BASE}${file}#L${line}`;
}

export const FIXED_MARKERS: readonly FixedMarker[] = [
  {
    kind: 'obfuscator marker',
    hex: '726d63656a256f746225',
    line: 5,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'obfuscator marker',
    hex: '436f742533743d73687450',
    line: 6,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'obfuscator marker',
    hex: '5f245f31653432',
    line: 7,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'obfuscator marker',
    hex: '66756e6374696f6e204d4479',
    line: 8,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'campaign tag',
    hex: '676c6f62616c5b2721275d',
    line: 9,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'campaign tag',
    hex: '676c6f62616c5b275f56275d',
    line: 10,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'campaign tag',
    hex: '676c6f62616c5b225f56225d',
    line: 11,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'XOR key',
    hex: '325b675766476a3b3c3a2d39335a5e43',
    line: 12,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'XOR key',
    hex: '6d363a7454685e442963427a3f4e4d5d',
    line: 13,
    reported: 'OpenSourceMalware, PolinRider dossier',
  },
  {
    kind: 'blockchain address',
    hex: '544d664b51456437544a4a6135784e5a4a5a324c657038333876727a7273376d4150',
    line: 16,
  },
  {
    kind: 'blockchain address',
    hex: '545866784855657439704a5655314267566b42416272455334595563316e477a6347',
    line: 17,
  },
  {
    kind: 'blockchain address',
    hex: '307862653033373430303637306662663163333233363466373632393735393038646334336565623338373539323633653764666364616263373633383038313165',
    line: 18,
  },
  {
    kind: 'blockchain address',
    hex: '307833663065353738316430383535666234363036363161633633323537333736646231393431623262623532323439396534373537656362336562643564636533',
    line: 19,
  },
  {
    kind: 'campaign id',
    hex: '65396235336137632d323334322d346231352d623032642d626438623866366130336639',
    line: 22,
  },
  {
    kind: 'C2 host',
    hex: '64656661756c742d636f6e66696775726174696f6e2e76657263656c2e617070',
    line: 23,
  },
  {
    kind: 'C2 host',
    hex: '7673636f64652d73657474696e67732d626f6f7473747261702e76657263656c2e617070',
    line: 24,
  },
  {
    kind: 'C2 host',
    hex: '7673636f64652d73657474696e67732d636f6e6669672e76657263656c2e617070',
    line: 25,
  },
  {
    kind: 'C2 host',
    hex: '7673636f64652d626f6f7473747261707065722e76657263656c2e617070',
    line: 26,
  },
  { kind: 'C2 host', hex: '7673636f64652d6c6f61642d636f6e6669672e76657263656c2e617070', line: 27 },
  { kind: 'C2 host', hex: '3236303132302e76657263656c2e617070', line: 28 },
  {
    kind: 'fake font command',
    hex: '6e6f6465202e2f7075626c69632f666f6e74732f66612d736f6c69642d3430302e776f666632',
    line: 48,
    reported: 'OpenSourceMalware, 2026-08',
  },
  {
    kind: 'campaign tag',
    hex: '4131302d6e706d3321',
    line: 56,
    reported: 'OpenSourceMalware, 2026-08',
  },
  {
    kind: 'blockchain address',
    hex: '307861333232653566336433313164333038306536663031323130363365396164633234393065663161',
    line: 57,
    reported: 'OpenSourceMalware, 2026-08',
  },
  {
    kind: 'campaign tag',
    hex: '676c6f62616c2e693d2241382d',
    line: 67,
    reported: 'OpenSourceMalware, 2026-08',
  },
  {
    kind: 'campaign tag',
    hex: '676c6f62616c2e69203d20274138',
    line: 78,
    reported: 'OpenSourceMalware, 2026-09',
  },
  {
    kind: 'XOR key',
    hex: '7134465a6b78587b2168',
    line: 88,
    reported: 'OpenSourceMalware, 2026-09',
  },
  {
    kind: 'XOR key',
    hex: '792d705f3e6424304226405e3161516b',
    line: 89,
    reported: 'OpenSourceMalware, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '3333666633656461663535613865303364636263376362343064343938613439',
    line: 104,
    reported: 'SafeDep, 2026-09',
  },
  { kind: 'obfuscator marker', hex: '5f245f66656430', line: 105, reported: 'SafeDep, 2026-09' },
  {
    kind: 'campaign tag',
    hex: '676c6f62616c2e6f3d27352d',
    line: 106,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'XOR key',
    hex: '5955376d7b72452f3e7c3d3d623e237e',
    line: 107,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '307861333232453566334433313144333038306536663031323130363365396144433234393045663161',
    line: 116,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '54437166365a6b61514438347659734332637575316a527742364a76655461527246',
    line: 122,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '54464d727942396d3664346b424d526a455679465262714b5356316356324e637048',
    line: 123,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '307833643230373566393762376231653332333462643635333737396432316336303564376438633665633963393864393833383830626535633766346639343731',
    line: 124,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '307839643230326338323434303263613839653961616363643233393062366638623333326165373433636161313436396336393566656232373831643536353139',
    line: 125,
    reported: 'SafeDep, 2026-09',
  },
  {
    kind: 'payload staging account',
    hex: '7465737432363333303333312f74657374',
    line: 147,
    reported: 'Deception.Pro, 2026-09',
  },
  {
    kind: 'blockchain address',
    hex: '307831656566303834396564613135643837663634653531633733633834343263663363386263656633',
    line: 161,
    reported: 'GitGuardian, Greenflagged and Sonatype, 2026-10 and 2026-11',
  },
  {
    kind: 'campaign tag',
    hex: '5a327876596d46734c6d6b675053416e',
    line: 174,
    reported: 'Greenflagged and OpenSSF MAL-2026-18643, 2026-11',
  },
  {
    kind: 'campaign tag',
    hex: '4131302d6e706d5f696e6a656374',
    line: 175,
    reported: 'Greenflagged and OpenSSF MAL-2026-18643, 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a4d323630363330412a2f',
    line: 189,
    reported: 'Greenflagged, GitGuardian and Abnormal AI, 2026-10 and 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a4e504d5f57535f5348494d2a2f',
    line: 190,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a52533236303630352a2f',
    line: 191,
    reported: 'Greenflagged, GitGuardian and Abnormal AI, 2026-10 and 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a43323530363137412a2f',
    line: 192,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a43323530363138412a2f',
    line: 193,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a43323530363139412a2f',
    line: 194,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a43323530363230412a2f',
    line: 195,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'stage 2 marker',
    hex: '2f2a43323630353131412a2f',
    line: 196,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'XOR key',
    hex: '54685a472b306a665845365641474f4a',
    line: 202,
    reported: 'Greenflagged, 2026-11',
  },
  {
    kind: 'payload server',
    hex: '616363757261736f6674686972652e636f6d',
    line: 209,
    reported: 'JFrog Security Research, 2026-11',
  },
];

/**
 * A marker with a part that changes between builds, so a fixed string can't match it. Each has
 * a fixed `anchor` that every match contains: the rule finds the anchor with indexOf, then checks
 * a short stretch of text around it. No regular expression ever runs over a whole line, so a
 * payload line megabytes long can't make the scan slow.
 */
export interface PatternMarker {
  kind: MarkerKind;
  /** Its line in strong-patterns.txt. See sourceOf(). */
  line: number;
  anchor: string;
  /** Where the match starts, given the anchor's offset in `text`, or -1 when it isn't one. */
  matchAt(text: string, at: number): number;
}

/** How far back a pattern looks from its anchor, at most. */
const LOOK_BACK = 512;
const PADDING = 64;

export const PATTERN_MARKERS: readonly PatternMarker[] = [
  {
    // node running a file named like a Font Awesome font: the command of the fake-font tasks,
    // for any three-digit weight. The font path must be node's argument, so a script that is
    // only handed a font name doesn't match. Same as strong-patterns.txt, except that a path
    // longer than 512 characters isn't followed back.
    kind: 'fake font command',
    line: 18,
    anchor: 'fa-solid-',
    matchAt(text, at) {
      if (!/^[0-9]{3}\.woff2/.test(text.slice(at + 9, at + 18))) return -1;
      const limit = Math.max(0, at - LOOK_BACK);
      let p = at;
      while (p > limit && !isPathEnd(text.charCodeAt(p - 1))) p--;
      if (text[p - 1] !== ' ') return -1;
      while (p > limit && text[p - 1] === ' ') p--;
      return text.slice(p - 4, p) === 'node' ? p - 4 : -1;
    },
  },
  {
    // A campaign tag assigned to a variable called z, straight after 64 or more spaces or tabs.
    // The padding is required, so the same assignment in minified code doesn't match.
    kind: 'campaign tag',
    line: 32,
    anchor: "var z = '-",
    matchAt(text, at) {
      if (at < PADDING) return -1;
      for (let p = at - PADDING; p < at; p++) {
        const code = text.charCodeAt(p);
        if (code !== 0x20 && code !== 0x09) return -1;
      }
      return /^[0-9]+(?:-[0-9]+)?';/.test(text.slice(at + 10, at + 60)) ? at : -1;
    },
  },
  {
    // A campaign tag assigned to global.i: either quote, an "A" and a one- or two-digit campaign
    // number, then a dash or the closing quote.
    kind: 'campaign tag',
    line: 45,
    anchor: 'global.i',
    matchAt(text, at) {
      return /^ ?= ?['"]A[0-9]{1,2}[-'"]/.test(text.slice(at + 8, at + 16)) ? at : -1;
    },
  },
];

/** The characters that end a path in a command: a space, a quote or a line break. */
function isPathEnd(code: number): boolean {
  return code === 0x20 || code === 0x22 || code === 0x27 || code === 0x0a || code === 0x0d;
}
