#!/usr/bin/env node
import pc from 'picocolors';
import { main } from './cli.js';
import { runEntryPoint } from './entry-point.js';

// picocolors enables color for every Windows process, even when output goes to a file or pipe.
// CI logs stay plain unless FORCE_COLOR asks for color.
const color = pc.isColorSupported && (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR));

// Animate only for a person at a terminal, never in CI or when output is piped.
const interactive = Boolean(process.stdout.isTTY) && !process.env.CI && process.env.TERM !== 'dumb';

runEntryPoint((io) => main(process.argv.slice(2), io), {
  color,
  interactive,
  width: process.stdout.columns,
});
