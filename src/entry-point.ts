import type { Io } from './cli.js';
import { EXIT_TOOL_ERROR } from './exit-code.js';

/**
 * Runs an entry point (the CLI or the GitHub Action) with its output going to this process's
 * stdout and stderr, then sets the process's exit code to the code it returns. A crash prints the
 * stack trace and exits with EXIT_TOOL_ERROR. Left unhandled, it would exit with 1, which
 * devsweep uses for "findings".
 */
export function runEntryPoint(
  run: (io: Io) => Promise<number>,
  options: Omit<Io, 'stdout' | 'stderr'>,
): void {
  run({
    ...options,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`devsweep: unexpected error\n${detail}\n`);
      process.exitCode = EXIT_TOOL_ERROR;
    },
  );
}
