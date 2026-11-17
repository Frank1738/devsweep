import { open } from 'node:fs/promises';
import path from 'node:path';
import { compareText } from '../../compare.js';
import { limiter } from '../../concurrency.js';
import { errorMessage } from '../../errors.js';
import type { Check, Finding, ScanContext } from '../../types.js';
import { listFiles } from '../../walk.js';
import * as autorunTask from './autorun-task.js';
import { SETTINGS_FILE, TASKS_FILE } from './autorun-task.js';
import * as disguisedFile from './disguised-file.js';
import * as hiddenPadding from './hidden-padding.js';
import { allStrings, field, JsoncParseError, type JsonValue, parseJsonc } from './jsonc.js';
import * as knownMarker from './known-marker.js';
import * as propagationScript from './propagation-script.js';
import { baseName } from './text.js';

/** Text files larger than this aren't read. Payload lines can be megabytes long. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * How much of a file is read first, to tell binary from text: a zero byte in it means binary.
 * Git reads the same amount. It also covers the font check's disguisedFile.HEAD_BYTES.
 */
const SNIFF_BYTES = 8000;

/**
 * Files read at once, across every project being scanned. Each is read whole, so this also
 * bounds memory: 8 × 8 MiB at most, however many projects --all scans together.
 */
const readSlot = limiter(8);

/**
 * Folders that build tools fill with generated code, at any depth: Next.js, Nuxt, SvelteKit,
 * Turborepo, Vercel, Parcel and Angular caches and output. Nobody edits or reviews them, they are
 * rebuilt from the source the rules already read, and bundled code in them pads lines in ways
 * that look like hiding. An infected config file is still found in the source.
 */
export const GENERATED_FOLDERS = [
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.parcel-cache',
  '.angular',
];

/**
 * Signs of malicious code planted in a repository, such as the PolinRider campaign's. Every rule
 * reads files as text and never runs them.
 */
export const codeCheck: Check = {
  id: 'code',
  description: 'Signs of malicious code planted in the repository',
  rules: [
    autorunTask.autorunTask,
    hiddenPadding.hiddenPadding,
    disguisedFile.disguisedFile,
    propagationScript.propagationScript,
    knownMarker.knownMarker,
  ],
  looksFor: [TASKS_FILE, 'text files'],

  run: fileFindings,
};

/**
 * code/autorun-task, from the tasks.json and settings.json the file loop already read and parsed.
 * Undefined when the file isn't there.
 */
function autorunFindings(
  ctx: ScanContext,
  tasks: JsonValue | JsoncParseError | undefined,
  settingsText: string | undefined,
): Finding[] {
  if (tasks === undefined) return [];
  if (tasks instanceof JsoncParseError) {
    ctx.warn(`Skipped invalid JSONC: ${tasks.message}`, TASKS_FILE);
    return [];
  }

  // settings.json only raises severity. If it can't be read, the tasks are still reported.
  const settings = settingsText === undefined ? undefined : parseOrError(settingsText);
  if (settings instanceof JsoncParseError) {
    ctx.warn(
      `Couldn't read "task.allowAutomaticTasks", invalid JSONC: ${settings.message}`,
      SETTINGS_FILE,
    );
  }
  const allowAutomaticTasks =
    settings !== undefined && !(settings instanceof JsoncParseError) && allowsAutomatic(settings);

  return autorunTask.analyze(tasks, { allowAutomaticTasks });
}

/**
 * The rules that read every file. The project's files are listed once, and each file is opened
 * once, read, and handed to every rule that applies to it.
 */
async function fileFindings(ctx: ScanContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  /** Commands from tasks.json and package.json files, in lower case, by file. */
  const commands: { file: string; commands: string[] }[] = [];
  const fonts: { file: string; head: disguisedFile.FileHead }[] = [];
  let tasks: JsonValue | JsoncParseError | undefined;
  let settingsText: string | undefined;

  const check = async (name: string) => {
    let file: ReadResult;
    try {
      file = await readOnce(path.join(ctx.root, name));
    } catch (error) {
      ctx.warn(
        `Couldn't read this file, so the code rules didn't check it: ${errorMessage(error)}`,
        name,
      );
      return;
    }

    // Scripts and fonts are checked by name and first bytes, even when binary or large.
    if (propagationScript.isScript(name)) {
      ctx.scannedFile();
      findings.push(propagationScript.scriptFinding(name));
    }
    if (disguisedFile.isCandidate(name)) {
      ctx.scannedFile();
      const bytes = file.bytes.subarray(0, disguisedFile.HEAD_BYTES);
      fonts.push({ file: name, head: { bytes, size: file.size } });
    }
    if (file.binary) return;
    if (file.size > MAX_TEXT_BYTES) {
      ctx.warn(
        `Skipped: larger than ${MAX_TEXT_BYTES / 1024 / 1024} MiB, so the code rules didn't read it.`,
        name,
      );
      return;
    }

    ctx.scannedFile();
    const text = file.bytes.toString('utf8');
    if (hiddenPadding.appliesTo(name)) findings.push(...hiddenPadding.analyze(name, text));
    if (knownMarker.appliesTo(name)) findings.push(...knownMarker.analyze(name, text));
    if (propagationScript.isGitignore(name)) {
      findings.push(...propagationScript.analyzeGitignore(name, text));
    }
    let found: string[];
    if (name === TASKS_FILE) {
      tasks = parseOrError(text);
      found = tasks instanceof JsoncParseError ? [] : taskCommands(tasks);
    } else {
      if (name === SETTINGS_FILE) settingsText = text;
      found = commandsIn(name, text);
    }
    if (found.length > 0) commands.push({ file: name, commands: found });
  };

  // Each file is read as soon as the listing finds it, while the rest is still being listed.
  const reading: Promise<void>[] = [];
  const listed = await listFiles(ctx.root, {
    skipFolders: ctx.skipFolders,
    skipNames: GENERATED_FOLDERS,
    readdir: ctx.readdir,
    onFile: (name) => reading.push(readSlot(() => check(name))),
  });
  for (const folder of listed.unreadable) {
    ctx.warn("Couldn't open this folder, so the code rules didn't check it.", folder);
  }
  await Promise.all(reading);
  // Files finish in any order; sorting keeps "a command in X names it" the same on every run.
  commands.sort((a, b) => compareText(a.file, b.file));

  findings.push(...autorunFindings(ctx, tasks, settingsText));

  // Fonts are checked last, once every command that could run one has been read.
  for (const { file, head } of fonts) {
    const namedBy = commands.find((source) => disguisedFile.namesFile(source.commands, file));
    findings.push(...disguisedFile.analyze(file, head, namedBy?.file));
  }
  return findings;
}

interface ReadResult {
  size: number;
  /** True when the first SNIFF_BYTES hold a zero byte, which text files never do. */
  binary: boolean;
  /** The whole file when it is text within MAX_TEXT_BYTES, otherwise its first bytes. */
  bytes: Buffer;
}

/**
 * Opens a file once. Reads its first bytes, then the rest only when those look like text and
 * the file is within MAX_TEXT_BYTES, so a large video costs one small read.
 */
async function readOnce(file: string): Promise<ReadResult> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const whole = size <= MAX_TEXT_BYTES;
    const buffer = Buffer.allocUnsafe(whole ? size : SNIFF_BYTES);
    let read = await fill(handle, buffer, 0, Math.min(buffer.length, SNIFF_BYTES));
    const binary = buffer.subarray(0, read).includes(0);
    if (whole && !binary) read = await fill(handle, buffer, read, buffer.length);
    return { size, binary, bytes: buffer.subarray(0, read) };
  } finally {
    await handle.close();
  }
}

/** Reads into `buffer` from `from` until `to`, or the end of the file. Returns where it stopped. */
async function fill(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  from: number,
  to: number,
): Promise<number> {
  let at = from;
  while (at < to) {
    const { bytesRead } = await handle.read(buffer, at, to - at, at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return at;
}

/**
 * The commands in a VS Code tasks.json (every string in its tasks) or a package.json (its npm
 * scripts), in lower case. Files that don't parse give none: code/autorun-task already warns
 * about an invalid tasks.json.
 */
function commandsIn(file: string, text: string): string[] {
  const name = baseName(file);
  if (name === 'tasks.json' && path.posix.basename(path.posix.dirname(file)) === '.vscode') {
    const parsed = parseOrError(text);
    return parsed instanceof JsoncParseError ? [] : taskCommands(parsed);
  }
  if (name === 'package.json') {
    try {
      const scripts: unknown = JSON.parse(text)?.scripts;
      if (typeof scripts !== 'object' || scripts === null) return [];
      return Object.values(scripts).flatMap((v) =>
        typeof v === 'string' ? [v.toLowerCase()] : [],
      );
    } catch {
      return [];
    }
  }
  return [];
}

/** Settings may be written flat (`"task.allowAutomaticTasks"`) or nested (`"task": { … }`). */
function allowsAutomatic(settings: JsonValue): boolean {
  const value =
    field(settings, 'task.allowAutomaticTasks')?.value ??
    field(field(settings, 'task')?.value, 'allowAutomaticTasks')?.value;
  return value?.kind === 'string' && value.value === 'on';
}

/** Every string in a tasks.json's tasks, in lower case. */
function taskCommands(tasks: JsonValue): string[] {
  return allStrings(field(tasks, 'tasks')?.value).map((s) => s.toLowerCase());
}

/** The parsed JSONC, or the parse error when it isn't JSONC. */
function parseOrError(text: string): JsonValue | JsoncParseError {
  try {
    return parseJsonc(text);
  } catch (error) {
    if (error instanceof JsoncParseError) return error;
    throw error;
  }
}
