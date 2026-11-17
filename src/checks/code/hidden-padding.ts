import { count, list, plural } from '../../format.js';
import { createFinding, type Finding, type Rule } from '../../types.js';
import { extensionOf, forEachLine, isNameChar } from './text.js';

export const hiddenPadding: Rule = {
  id: 'code/hidden-padding',
  title: 'Code hidden after a long run of spaces',
  severity: 'high',
  hidesSource: true,
  description:
    'A line has 64 or more spaces or tabs in a row, then more code. Code that far to the right ' +
    "is off-screen in most editors and in GitHub's diff view, so a reviewer doesn't see it. " +
    'Every known variant of the PolinRider malware campaign hides its loader this way, at the end ' +
    'of a real file such as a build config. Critical when the hidden code also runs text as code ' +
    '(eval, new Function), decodes base64 (atob, Buffer.from) or sets a global variable. ' +
    'Markdown, .txt and .csv files are skipped, and so is padding followed by a comment.',
  remediation:
    "Open the file in a plain text editor with line wrapping on, or scroll to the line's end, " +
    "and read what follows the spaces. If you didn't write it, don't build or run the project: " +
    "delete the hidden code, check the file's git history for who added it, and check the rest " +
    'of the repository and your machine. If the long line is intended, such as generated data, ' +
    'accept the finding in devsweep.config.json.',
};

/** The shortest run of spaces and tabs after code that counts as padding. */
export const MIN_PADDING = 64;

/**
 * The shortest run that counts at the start of a line. Deep indentation in HTML templates and
 * generated bundles reaches 70 to 80; a line indented 128 already looks empty in most editors.
 */
export const MIN_INDENT_PADDING = 128;

/**
 * Prose and data files, where long runs of spaces are layout, not hiding, and source maps, which
 * hold copies of source files already read on their own.
 */
const SKIPPED_EXTENSIONS = new Set(['md', 'txt', 'csv', 'map']);

/** How many other padded lines a finding names before it just counts them. */
const OTHER_LINES_SHOWN = 5;

/** How far past a match the checks for running code look. Keeps each check short. */
const NEAR = 400;

export function appliesTo(file: string): boolean {
  return !SKIPPED_EXTENSIONS.has(extensionOf(file));
}

export interface Padding {
  /** 1-based column where the hidden code starts. */
  column: number;
  spaces: number;
  tabs: number;
  /** Characters from the hidden code's start to the end of the line, without trailing spaces. */
  codeLength: number;
  /** What the hidden code does that makes it critical, in plain words. Empty when nothing. */
  signs: string[];
}

/**
 * Finds the first run of spaces and tabs that is followed by code on the same line: 64 or more
 * after other text, or 128 or more at the start of the line. Reads the line once, counting
 * spaces, so a line megabytes long is still quick. Padding before the end of the line, before a
 * comment, or inside a comment line isn't hiding anything that runs, and doesn't count.
 */
export function findPadding(line: string): Padding | undefined {
  let end = line.length;
  // A carriage return left over from a Windows line ending isn't code either.
  while (end > 0 && (isBlank(line.charCodeAt(end - 1)) || line.charCodeAt(end - 1) === 0x0d)) {
    end--;
  }

  let run = 0;
  let spaces = 0;
  for (let i = 0; i < end; i++) {
    const code = line.charCodeAt(i);
    if (isBlank(code)) {
      run++;
      if (code === 0x20) spaces++;
      continue;
    }
    const atLineStart = run === i;
    if (run >= (atLineStart ? MIN_INDENT_PADDING : MIN_PADDING)) {
      if (!atLineStart && insideCommentLine(line, i - run)) return undefined;
      const start = codeStart(line, i, end);
      if (start === -1) return undefined;
      return {
        column: start + 1,
        spaces,
        tabs: run - spaces,
        codeLength: end - start,
        signs: dangerSigns(line, start),
      };
    }
    run = 0;
    spaces = 0;
  }
  return undefined;
}

/** Any run long enough to be padding. One native search rules out almost every file. */
const LONG_RUN = new RegExp(`[ \\t]{${MIN_PADDING}}`);

/** The single finding for a file: its most telling padded line, naming the others. */
export function analyze(file: string, text: string): Finding[] {
  if (!LONG_RUN.test(text)) return [];
  const padded: { line: number; padding: Padding }[] = [];
  forEachLine(text, (line, number) => {
    const padding = findPadding(line);
    if (padding) padded.push({ line: number, padding });
  });
  const shown = padded.find((p) => p.padding.signs.length > 0) ?? padded[0];
  if (!shown) return [];

  const { padding } = shown;
  let message =
    `${describePadding(padding)}, then ${plural(padding.codeLength, 'character')} of code ` +
    `at column ${count(padding.column)}. Code this far right is off-screen in most editors, ` +
    'which is how the PolinRider campaign hides its loader.';
  if (padding.signs.length > 0) message += ` The hidden code ${list(padding.signs)}.`;
  const others = padded.filter((p) => p !== shown).map((p) => count(p.line));
  if (others.length > 0) {
    const named = others.slice(0, OTHER_LINES_SHOWN);
    const rest = others.length - named.length;
    message +=
      ` ${plural(others.length, 'other line')} in this file ${others.length === 1 ? 'is' : 'are'}` +
      ` padded the same way: ${list(rest > 0 ? [...named, `${count(rest)} more`] : named)}.`;
  }

  return [
    createFinding(hiddenPadding, {
      file,
      at: { line: shown.line, column: padding.column },
      message,
      severity: padding.signs.length > 0 ? 'critical' : 'high',
    }),
  ];
}

function isBlank(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/** "438 spaces", "131 tabs", "200 spaces and tabs". */
function describePadding({ spaces, tabs }: Padding): string {
  if (tabs === 0) return plural(spaces, 'space');
  if (spaces === 0) return plural(tabs, 'tab');
  return `${count(spaces + tabs)} spaces and tabs`;
}

/**
 * True when the line starts with a comment that is still open where the padding starts at
 * `paddingStart`: a `//`, `#` or `--` line, or a `/*` or `*` line whose comment hasn't closed.
 * Code there never runs: these are lined-up notes. Only the line's start is checked, so a `//`
 * inside a string, such as a URL, can't hide a payload.
 */
function insideCommentLine(line: string, paddingStart: number): boolean {
  let i = 0;
  while (i < paddingStart && isBlank(line.charCodeAt(i))) i++;
  if (line.startsWith('//', i) || line.startsWith('#', i) || line.startsWith('--', i)) return true;
  if (line.startsWith('/*', i) || line.startsWith('*', i)) {
    // A line can also start by closing a comment, as in ` */ code`.
    const closed = line.indexOf('*/', line.startsWith('/*', i) ? i + 2 : i);
    return closed === -1 || closed + 2 > paddingStart;
  }
  return false;
}

/**
 * Where the code after the padding starts, skipping comments, or -1 when only comments follow.
 * A block comment that closes on the same line is skipped, and whatever follows it still counts:
 * a payload can start with a comment.
 */
function codeStart(line: string, from: number, end: number): number {
  let i = from;
  while (i < end) {
    if (line.startsWith('/*', i) || line.startsWith('<!--', i)) {
      const close = line.startsWith('/*', i) ? '*/' : '-->';
      const closed = line.indexOf(close, i + 2);
      if (closed === -1 || closed >= end) return -1;
      i = closed + close.length;
      while (i < end && isBlank(line.charCodeAt(i))) i++;
      continue;
    }
    const lineComment =
      line.startsWith('//', i) ||
      line.startsWith('#', i) ||
      line.startsWith('--', i) ||
      (line.startsWith('*', i) && !line.startsWith('*/', i));
    return lineComment ? -1 : i;
  }
  return -1;
}

/**
 * The signs that hidden code runs something, in plain words. Each search is one pass with
 * indexOf, and each match is checked within a few hundred characters, so this stays linear.
 */
function dangerSigns(line: string, from: number): string[] {
  const signs: string[] = [];
  if (findCall(line, from, 'eval(')) signs.push('runs text as code (eval)');
  if (findCall(line, from, 'new Function('))
    signs.push('builds a function from text (new Function)');
  if (findCall(line, from, 'atob(')) signs.push('decodes base64 (atob)');
  if (decodesBase64Buffer(line, from)) signs.push('decodes base64 (Buffer.from)');
  const global = globalAssignment(line, from);
  if (global === 'require') signs.push('puts require or module on a global variable');
  else if (global === 'value') signs.push('sets a global variable');
  return signs;
}

/** True when `call` appears from `from` on, not as the end of a longer name like `myeval(`. */
function findCall(text: string, from: number, call: string): boolean {
  for (let at = text.indexOf(call, from); at !== -1; at = text.indexOf(call, at + 1)) {
    if (at === 0 || !isNameChar(text.charCodeAt(at - 1))) return true;
  }
  return false;
}

/** `Buffer.from(` with `base64` in the next few hundred characters. */
function decodesBase64Buffer(text: string, from: number): boolean {
  const call = 'Buffer.from(';
  for (let at = text.indexOf(call, from); at !== -1; at = text.indexOf(call, at + 1)) {
    if (text.slice(at + call.length, at + call.length + NEAR).includes('base64')) return true;
  }
  return false;
}

/**
 * Finds an assignment to a property of `global` or `globalThis`, such as `global.x = …` or
 * `global['x'] = …`. Returns 'require' when the value is `require` or `module`, the loader's
 * way of reaching Node's modules from code run by eval.
 */
function globalAssignment(text: string, from: number): 'require' | 'value' | undefined {
  let found: 'value' | undefined;
  for (let at = text.indexOf('global', from); at !== -1; at = text.indexOf('global', at + 6)) {
    if (at > 0 && isNameChar(text.charCodeAt(at - 1))) continue;
    let p = at + 6;
    if (text.startsWith('This', p)) p += 4;
    if (text[p] === '.') {
      const nameStart = ++p;
      while (p - nameStart < 64 && isNameChar(text.charCodeAt(p))) p++;
      if (p === nameStart) continue;
    } else if (text[p] === '[') {
      const close = text.slice(p, p + 66).indexOf(']');
      if (close === -1) continue;
      p += close + 1;
    } else {
      continue;
    }
    p = skipBlanks(text, p);
    if (text[p] !== '=' || text[p + 1] === '=' || text[p + 1] === '>') continue;
    p = skipBlanks(text, p + 1);
    for (const value of ['require', 'module']) {
      if (text.startsWith(value, p) && !isNameChar(text.charCodeAt(p + value.length))) {
        return 'require';
      }
    }
    found = 'value';
  }
  return found;
}

/** Skips up to 16 spaces and tabs: enough for any real assignment, and never a long scan. */
function skipBlanks(text: string, from: number): number {
  let p = from;
  while (p - from < 16 && isBlank(text.charCodeAt(p))) p++;
  return p;
}
