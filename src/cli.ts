import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { formatJson } from './reporters/json.js';
import { formatPretty } from './reporters/pretty.js';
import { ScanTargetError, scan } from './scanner.js';
import { bannerFits, playBanner, renderBanner } from './ui/banner.js';
import { startSweep } from './ui/sweep.js';
import { sleep } from './ui/terminal.js';
import { VERSION } from './version.js';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
  /** A person is watching a terminal: animate. False in CI, pipes and files. */
  interactive: boolean;
  /** Terminal width in columns, when known. */
  width?: number | undefined;
}

/** Exit codes. Findings don't affect the exit code yet; `--fail-on` arrives in Phase 2. */
export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 2;

interface ScanFlags {
  json?: boolean;
  details?: boolean;
  /** False when --no-color is passed. */
  color?: boolean;
}

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

  program
    .command('scan', { isDefault: true })
    .description('scan a repository for risky settings (the default command)')
    .argument('[path]', 'directory to scan', '.')
    .option('-d, --details', 'explain each finding and how to fix it')
    .option('--json', 'print results as JSON')
    .option('--no-color', 'turn off colors')
    .action(async (target: string, flags: ScanFlags) => {
      const color = io.color && flags.color !== false;
      const animate = io.interactive && !flags.json;
      const banner = animate && bannerFits(io.width);
      const shownTarget = displayTarget(target);

      // Start scanning right away, so the work overlaps the animations.
      let scanned = false;
      const scanning = settle(scan({ root: target })).finally(() => {
        scanned = true;
      });
      if (banner) await playBanner(io.stdout, { color, version: VERSION, width: io.width });
      // The sweep shows progress, so skip it when the scan finished while the banner drew.
      const stopSweep =
        animate && !(banner && scanned)
          ? startSweep({ write: io.stdout, label: shownTarget, color, width: io.width })
          : undefined;
      const outcome = await scanning;
      await stopSweep?.();

      if (!outcome.ok) {
        if (!(outcome.error instanceof ScanTargetError)) throw outcome.error;
        io.stderr(`devsweep: ${outcome.error.message}\n`);
        exitCode = EXIT_TOOL_ERROR;
        return;
      }
      const result = outcome.value;

      if (flags.json) {
        io.stdout(formatJson(result, VERSION));
      } else {
        const report = formatPretty(result, {
          target: shownTarget,
          color,
          showName: !banner,
          details: flags.details,
          width: io.width,
          readLines: sourceReader(result.root),
        });
        if (animate) await reveal(io, report);
        else io.stdout(report);
      }
      if (result.errors.length > 0) exitCode = EXIT_TOOL_ERROR;
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return exitCode;
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

/** Reads scanned files on demand, for code excerpts in --details output. */
function sourceReader(root: string): (file: string) => string[] | undefined {
  const cache = new Map<string, string[] | undefined>();
  return (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(path.join(root, file), 'utf8').split(/\r?\n/));
      } catch {
        cache.set(file, undefined);
      }
    }
    return cache.get(file);
  };
}
