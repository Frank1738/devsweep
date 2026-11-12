import { randomUUID } from 'node:crypto';
import { appendFile, stat } from 'node:fs/promises';
import { type Io, main } from './cli.js';
import { DEFAULT_FAIL_ON } from './exit-code.js';
import type { Env } from './types.js';

/** Inputs and defaults, matching action.yml. */
const DEFAULTS = {
  path: '.',
  'fail-on': DEFAULT_FAIL_ON,
  'sarif-file': 'devsweep.sarif',
} as const;

type InputName = keyof typeof DEFAULTS;

/**
 * Runs devsweep as a GitHub Action and returns the exit code. GitHub passes each input as an
 * INPUT_<NAME> environment variable (upper case, hyphens kept), and reads outputs from the file
 * named by GITHUB_OUTPUT. The readable report goes to the job log, and SARIF to `sarif-file`.
 */
export async function runAction(env: Env, io: Io): Promise<number> {
  const sarifFile = input(env, 'sarif-file');
  const before = await modifiedTime(sarifFile);
  // Options use the --name=value form and the path comes after "--", so no input can ever be
  // read as a different option.
  const code = await main(
    [
      'scan',
      '--sarif',
      `--output=${sarifFile}`,
      `--fail-on=${input(env, 'fail-on')}`,
      '--',
      input(env, 'path'),
    ],
    // The same environment holds the token (GITHUB_TOKEN), if the workflow passes one.
    { ...io, env },
  );
  // Only point at the file if this run wrote it, never at one left over from an earlier run.
  const after = await modifiedTime(sarifFile);
  if (after !== undefined && after !== before) await setOutput(env, 'sarif-file', sarifFile);
  return code;
}

function input(env: Env, name: InputName): string {
  return env[`INPUT_${name.toUpperCase()}`]?.trim() || DEFAULTS[name];
}

/** Uses GitHub's multiline syntax with a random delimiter, so a value can't inject more outputs. */
async function setOutput(env: Env, name: string, value: string): Promise<void> {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  await appendFile(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

/** When the file last changed, in milliseconds, or undefined when it doesn't exist. */
async function modifiedTime(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}
