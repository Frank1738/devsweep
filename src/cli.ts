import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command, CommanderError, Help, Option } from 'commander';
import pc from 'picocolors';
import { ConfigError } from './config.js';
import { errorMessage } from './errors.js';
import {
  DEFAULT_FAIL_ON,
  EXIT_OK,
  EXIT_TOOL_ERROR,
  exitCodeFor,
  exitCodeForAll,
  FAIL_ON,
  type FailOn,
} from './exit-code.js';
import { count, list } from './format.js';
import { findRepository } from './git.js';
import { formatJson, formatJsonAll } from './reporters/json.js';
import { ALL_OFFLINE_NOTE, formatPretty, formatPrettyAll } from './reporters/pretty.js';
import { formatSarif } from './reporters/sarif.js';
import { type ReadLines, sourceReader } from './reporters/source.js';
import { type ScanAllProgress, scanAll } from './scan-all.js';
import { ScanTargetError, scan } from './scanner.js';
import type { Env, ScanResult } from './types.js';
import { bannerFits, playBanner, renderBanner } from './ui/banner.js';
import { type Progress, startProgress } from './ui/progress.js';
import { startSweep } from './ui/sweep.js';
import { printable, sleep } from './ui/terminal.js';
import { VERSION } from './version.js';
import { PROJECT_MARKERS } from './walk.js';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
  /** A person is watching a terminal: animate. False in CI, pipes and files. */
  interactive: boolean;
  /** Terminal width in columns, when known. */
  width?: number | undefined;
  /** Where tokens are read from. Defaults to process.env. */
  env?: Env | undefined;
  /** For GitHub API calls. Defaults to the global fetch. */
  fetch?: typeof fetch | undefined;
}

interface ScanFlags {
  /** Always set: commander fills in the default and rejects anything else. */
  failOn: FailOn;
  json?: boolean;
  sarif?: boolean;
  /** Where to save the --json or --sarif report. */
  output?: string;
  details?: boolean;
  offline?: boolean;
  /** Find every project under the path and scan each one. */
  all?: boolean;
  /** False when --no-color is passed. */
  color?: boolean;
}

type MachineFormat = 'json' | 'sarif';

/** Runs the CLI with `argv` (user arguments only) and returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = EXIT_OK;

  const program = new Command()
    .name('devsweep')
    .description(
      'Scan your dev setup and repos for the supply-chain and credential risks that infostealers exploit.',
    )
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  if (io.interactive && bannerFits(io.width)) {
    const banner = renderBanner({ color: io.color, version: VERSION, width: io.width });
    program.addHelpText('beforeAll', `\n${banner.join('\n')}\n`);
  }

  const scanCommand = program
    .command('scan', { isDefault: true })
    .description('scan a repository for risky settings (the default command)')
    .argument('[path]', 'directory to scan', '.')
    .option('-d, --details', 'explain each finding and how to fix it')
    .addOption(
      new Option(
        '--fail-on <severity>',
        'exit with code 1 when a finding is at or above this severity',
      )
        .choices(FAIL_ON)
        .default(DEFAULT_FAIL_ON),
    )
    .option('--json', 'print results as JSON')
    .addOption(
      new Option('--sarif', 'print results as SARIF 2.1.0, for GitHub code scanning').conflicts(
        'json',
      ),
    )
    .option(
      '-o, --output <file>',
      'save the --json or --sarif report to a file, and show the readable report',
    )
    .option('--offline', 'skip the checks that call the GitHub API')
    .option(
      '--all',
      `find every project under the path (folders with ${list(PROJECT_MARKERS, 'or')}) and scan each one, offline`,
    )
    .option('--no-color', 'turn off colors');

  showDefaultCommandInHelp(program, scanCommand);

  scanCommand.action(async (target: string, flags: ScanFlags) => {
    const machine = machineFormat(flags);
    if (flags.output !== undefined && !machine) {
      scanCommand.error('error: --output needs --json or --sarif');
    }
    if (flags.all && machine === 'sarif') {
      scanCommand.error(
        "error: --sarif can't be used with --all: a SARIF report describes one repository, for that repository's Security tab. Use --json, or scan each repository on its own.",
      );
    }
    exitCode = flags.all
      ? await runAll(target, flags, machine, io)
      : await runOne(target, flags, machine, io);
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    // Help and --version exit 0. Usage mistakes get 2 rather than commander's 1, so that 1
    // always means "findings".
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT_OK : EXIT_TOOL_ERROR;
    throw error;
  }
  return exitCode;
}

/** `devsweep <path>`: scans one repository. Returns the exit code. */
async function runOne(
  target: string,
  flags: ScanFlags,
  machine: MachineFormat | undefined,
  io: Io,
): Promise<number> {
  // The readable report shows unless a machine format is going to stdout.
  const readable = !machine || flags.output !== undefined;
  const color = io.color && flags.color !== false;
  const animate = io.interactive && readable;
  const banner = animate && bannerFits(io.width);
  const shownTarget = displayTarget(target);

  const result = await runJob(
    scan({ root: target, offline: flags.offline ?? false, env: io.env, fetch: io.fetch }),
    io,
    color,
    banner,
    animate
      ? () => startSweep({ write: io.stdout, label: shownTarget, color, width: io.width })
      : undefined,
  );
  if (!result) return EXIT_TOOL_ERROR;

  const readLines = sourceReader(result.root);
  const saved = await emit(io, flags, color, animate, {
    machine: machine && { format: machine, text: await formatMachine(machine, result, readLines) },
    readable:
      readable &&
      (() =>
        formatPretty(result, {
          target: shownTarget,
          color,
          showName: !banner,
          details: flags.details,
          width: io.width,
          readLines,
        })),
  });
  return saved ? exitCodeFor(result, flags.failOn) : EXIT_TOOL_ERROR;
}

/**
 * `devsweep <path> --all`: finds every project under the path and scans each one, offline.
 * Returns the exit code.
 */
async function runAll(
  target: string,
  flags: ScanFlags,
  machine: MachineFormat | undefined,
  io: Io,
): Promise<number> {
  const readable = !machine || flags.output !== undefined;
  const color = io.color && flags.color !== false;
  // Progress and animation only for a person reading the readable report: never with --json.
  const animate = io.interactive && !machine;
  const banner = animate && bannerFits(io.width);
  const shownTarget = displayTarget(target);

  // Progress arrives once per folder searched; it is only put into words when the line redraws.
  let latest: ScanAllProgress | undefined;
  let progress: Progress | undefined;
  const all = await runJob(
    scanAll({
      root: target,
      env: io.env,
      onProgress: (p) => {
        latest = p;
        progress?.update();
      },
    }),
    io,
    color,
    banner,
    animate
      ? () => {
          progress = startProgress({
            write: io.stdout,
            text: () => (latest ? describeProgress(latest) : `searching ${shownTarget}`),
            color,
            width: io.width,
          });
          return progress.stop;
        }
      : undefined,
  );
  if (!all) return EXIT_TOOL_ERROR;

  const saved = await emit(io, flags, color, animate, {
    machine: machine && { format: machine, text: formatJsonAll(all, VERSION) },
    // The readable report carries this note; without it, say it on stderr, away from the JSON.
    note: ALL_OFFLINE_NOTE,
    readable:
      readable &&
      (() =>
        formatPrettyAll(all, {
          target: shownTarget,
          color,
          showName: !banner,
          details: flags.details,
          width: io.width,
          readerFor: sourceReader,
        })),
  });
  return saved ? exitCodeForAll(all, flags.failOn) : EXIT_TOOL_ERROR;
}

/**
 * Runs a scan while the banner plays, then shows `indicator` (a spinner or progress line) until
 * the scan is done. Returns undefined after printing why when the scan couldn't start.
 */
async function runJob<T>(
  job: Promise<T>,
  io: Io,
  color: boolean,
  banner: boolean,
  indicator: (() => () => unknown) | undefined,
): Promise<T | undefined> {
  // Start right away, so the work overlaps the animations.
  let finished = false;
  const running = settle(job).finally(() => {
    finished = true;
  });
  if (banner) await playBanner(io.stdout, { color, version: VERSION, width: io.width });
  // The indicator shows progress, so skip it when the scan finished while the banner drew.
  const stop = indicator && !(banner && finished) ? indicator() : undefined;
  const outcome = await running;
  await stop?.();

  if (outcome.ok) return outcome.value;
  if (!isSetupError(outcome.error)) throw outcome.error;
  // A config error can quote the scanned repository's config file.
  io.stderr(`devsweep: ${printable(outcome.error.message)}
`);
  return undefined;
}

interface Reports {
  /** The --json or --sarif report, when one was asked for. */
  machine: { format: MachineFormat; text: string } | undefined;
  /** Printed on stderr when the machine report goes to stdout and no readable report shows. */
  note?: string;
  /** Builds the readable report, when it shows. */
  readable: false | (() => string);
}

/**
 * Prints or saves the machine report, then shows the readable one. Returns false when the
 * report couldn't be saved.
 */
async function emit(
  io: Io,
  flags: ScanFlags,
  color: boolean,
  animate: boolean,
  reports: Reports,
): Promise<boolean> {
  const { machine } = reports;
  if (machine) {
    if (flags.output === undefined) {
      io.stdout(machine.text);
      if (reports.note)
        io.stderr(`devsweep: ${reports.note}
`);
    } else {
      const failure = await saveReport(flags.output, machine.text);
      if (failure) {
        io.stderr(`devsweep: ${failure}
`);
        return false;
      }
    }
  }

  if (reports.readable) {
    let report = reports.readable();
    if (machine && flags.output !== undefined) {
      const name = machine.format === 'sarif' ? 'SARIF' : 'JSON';
      report += `  ${pc.createColors(color).dim(`${name} report saved to ${flags.output}`)}
`;
    }
    if (animate) await reveal(io, report);
    else io.stdout(report);
  }
  return true;
}

function describeProgress(progress: ScanAllProgress): string {
  if (progress.stage === 'searching') {
    return `searching  ${count(progress.folders)} folders · ${count(progress.projects)} projects found`;
  }
  return `scanning ${count(progress.done + 1)} of ${count(progress.total)}  ${progress.project}`;
}

/**
 * `devsweep --help` lists the default command's argument and options too, since they work
 * without naming the command. Commander shows only the program's own by default.
 */
function showDefaultCommandInHelp(program: Command, command: Command): void {
  program.usage('[options] [path]').configureHelp({
    visibleArguments(cmd) {
      return Help.prototype.visibleArguments.call(this, cmd === program ? command : cmd);
    },
    visibleOptions(cmd) {
      const own = Help.prototype.visibleOptions.call(this, cmd);
      if (cmd !== program) return own;
      // The command's own help option would repeat the program's.
      const borrowed = Help.prototype.visibleOptions
        .call(this, command)
        .filter((option) => option.long !== '--help');
      return [...borrowed, ...own];
    },
  });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Captures a promise's result, so a failure can't go unhandled while we're busy animating. */
function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/** "." means little in a header; show the folder's name instead. */
function displayTarget(target: string): string {
  return target === '.' || target === './' ? path.basename(process.cwd()) : target;
}

/** Prints the report a line at a time, finishing in about a fifth of a second however long it is. */
async function reveal(io: Io, report: string, durationMs = 180): Promise<void> {
  const lines = report.replace(/\n$/, '').split('\n');
  const started = Date.now();
  let shown = 0;
  while (shown < lines.length) {
    const due = Math.ceil(((Date.now() - started) / durationMs) * lines.length);
    const until = Math.min(lines.length, Math.max(shown + 1, due));
    for (; shown < until; shown++) io.stdout(`${lines[shown]}\n`);
    if (shown < lines.length) await sleep(16);
  }
}

/** Problems with what the user asked for, shown as one line instead of a stack trace. */
function isSetupError(error: unknown): error is Error {
  return error instanceof ScanTargetError || error instanceof ConfigError;
}

function machineFormat(flags: ScanFlags): MachineFormat | undefined {
  if (flags.sarif) return 'sarif';
  if (flags.json) return 'json';
  return undefined;
}

async function formatMachine(
  format: MachineFormat,
  result: ScanResult,
  readLines: ReadLines,
): Promise<string> {
  if (format === 'json') return formatJson(result, VERSION);
  // GitHub needs paths from the repository root, even when only a subfolder was scanned.
  const repository = await findRepository(result.root);
  return formatSarif(result, {
    version: VERSION,
    pathFromRepoRoot: repository?.pathFromRoot,
    readLines,
  });
}

/** Writes a report, creating missing folders. Returns what went wrong, if anything. */
async function saveReport(file: string, text: string): Promise<string | undefined> {
  try {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, text, 'utf8');
    return undefined;
  } catch (error) {
    return `Couldn't save the report to ${file}: ${errorMessage(error)}`;
  }
}
