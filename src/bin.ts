#!/usr/bin/env node
import pc from 'picocolors';
import { EXIT_TOOL_ERROR, main } from './cli.js';

// picocolors enables color for every Windows process, even when output goes to a file or pipe.
const color =
  pc.isColorSupported &&
  (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR) || Boolean(process.env.CI));

// Animate only for a person at a terminal, never in CI or when output is piped.
const interactive = Boolean(process.stdout.isTTY) && !process.env.CI && process.env.TERM !== 'dumb';

main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color,
  interactive,
  width: process.stdout.columns,
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
