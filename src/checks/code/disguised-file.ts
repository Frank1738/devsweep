import { createFinding, type Finding, type Rule } from '../../types.js';
import { baseName, extensionOf } from './text.js';

export const disguisedFile: Rule = {
  id: 'code/disguised-file',
  title: "Font file that isn't a font",
  severity: 'high',
  hidesSource: true,
  description:
    'A file named like a font (.woff2, .woff, .ttf, .otf or .eot) whose first bytes are not any ' +
    'font format, or a font-like name no font uses, such as fa-solid-400.llf. The PolinRider ' +
    'malware campaign hides its JavaScript in fake Font Awesome fonts, then runs them with node ' +
    'from a VS Code task or an npm script. Critical when the file is mostly readable text, or a ' +
    'command in .vscode/tasks.json or package.json names it. Empty files and Git LFS pointers ' +
    '(the small text files left in place of fonts stored in Git LFS) are skipped.',
  remediation:
    "Don't run the file. Open it in a plain text editor: a real font is unreadable binary data. " +
    'If it holds code, delete it, remove any task or script that runs it, and check the ' +
    "repository's history for who added it. If you ran the project, treat your machine as " +
    'compromised and rotate tokens from a clean device. If the file is a real font in an unusual ' +
    'format, accept the finding in devsweep.config.json.',
};

/** The font formats checked, by extension, as named in findings. */
const FONT_FORMATS: Record<string, string> = {
  woff2: 'WOFF2',
  woff: 'WOFF',
  ttf: 'TrueType',
  otf: 'OpenType',
  eot: 'EOT',
};

/** Font Awesome-style names with extensions no font format uses, as PolinRider names them. */
const FAKE_FONT_NAME = /^fa-[a-z]+(?:-[0-9]{3})?\.(?:llf|lkf)$/i;

/** What a checkout leaves in place of a file stored in Git LFS, when LFS isn't installed. */
const LFS_POINTER = Buffer.from('version https://git-lfs.github.com/spec/v1');

/** How much of a file is read: enough for the "mostly text" test. */
export const HEAD_BYTES = 4096;

/** Share of printable bytes above which a file counts as text. Real fonts are far below it. */
const TEXT_SHARE = 0.9;

/** True for files this rule reads, by name alone. The walker lists them even when binary. */
export function isCandidate(file: string): boolean {
  return extensionOf(file) in FONT_FORMATS || FAKE_FONT_NAME.test(baseName(file));
}

export interface FileHead {
  /** The file's first bytes, up to HEAD_BYTES. */
  bytes: Buffer;
  size: number;
}

/**
 * Checks one candidate file. `namedBy` is the tasks.json or package.json whose command names
 * the file, if any.
 */
export function analyze(file: string, head: FileHead, namedBy: string | undefined): Finding[] {
  if (head.size === 0 || startsWith(head.bytes, LFS_POINTER)) return [];

  const fakeName = FAKE_FONT_NAME.test(baseName(file));
  if (!fakeName && isFont(head.bytes)) return [];

  const text = isMostlyText(head.bytes);
  let message = fakeName
    ? `Named like a Font Awesome font, but ".${extensionOf(file)}" isn't a font format. ` +
      'PolinRider names its fake fonts like this.'
    : `Named like a ${FONT_FORMATS[extensionOf(file)]} font, but it doesn't start with the ` +
      'signature of any font format.';
  if (text) {
    message +=
      ' It is mostly readable text, which is how PolinRider hides JavaScript in fake fonts.';
  }
  if (namedBy !== undefined) message += ` A command in ${namedBy} names it.`;

  return [
    createFinding(disguisedFile, {
      file,
      // The whole file is the problem. SARIF needs a line, and GitHub shows the alert there.
      at: { line: 1 },
      message,
      severity: text || namedBy !== undefined ? 'critical' : 'high',
    }),
  ];
}

/**
 * True when the bytes start like a font of any format: WOFF2, WOFF, TrueType (two signatures),
 * OpenType, a font collection, PostScript Type 1 in a TrueType wrapper, or EOT (whose signature
 * sits at byte 34). Any format is accepted for any font extension: a real font with the wrong
 * extension is a mistake, not an attack.
 */
function isFont(bytes: Buffer): boolean {
  const tag = bytes.subarray(0, 4).toString('latin1');
  if (['wOF2', 'wOFF', 'OTTO', 'true', 'ttcf', 'typ1'].includes(tag)) return true;
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return true;
  return bytes[34] === 0x4c && bytes[35] === 0x50;
}

/** True when nine bytes in ten are printable ASCII, tabs or line breaks. */
function isMostlyText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  let printable = 0;
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable++;
    }
  }
  return printable / bytes.length >= TEXT_SHARE;
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

/** True when one of the commands, given in lower case, contains the file's name. */
export function namesFile(commands: readonly string[], file: string): boolean {
  const name = baseName(file).toLowerCase();
  return commands.some((command) => command.includes(name));
}
