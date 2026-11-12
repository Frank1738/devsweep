import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runAction } from '../src/action.js';
import type { Io } from '../src/cli.js';
import { EXIT_FINDINGS, EXIT_OK, EXIT_TOOL_ERROR } from '../src/exit-code.js';
import { fixture } from './helpers.js';

let temp: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-action-'));
  stdout = '';
  stderr = '';
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function io(): Io {
  return {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: false,
    interactive: false,
  };
}

/** What a workflow step's environment looks like: inputs, plus the file for outputs. */
function env(inputs: Record<string, string>) {
  return {
    GITHUB_OUTPUT: path.join(temp, 'github-output'),
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
}

describe('runAction', () => {
  it('writes SARIF, sets the sarif-file output, and logs the readable report', async () => {
    const sarifFile = path.join(temp, 'out', 'devsweep.sarif');
    const code = await runAction(
      env({ path: fixture('vulnerable-repo'), 'fail-on': 'none', 'sarif-file': sarifFile }),
      io(),
    );
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(sarifFile, 'utf8')).runs[0].results).toHaveLength(10);
    expect(stdout).toContain('10 issues');
    expect(stdout).not.toContain('\u001b[');
    const output = await readFile(path.join(temp, 'github-output'), 'utf8');
    expect(output).toMatch(
      new RegExp(
        `^sarif-file<<(ghadelimiter_[0-9a-f-]{36})\\n${escapeRegExp(sarifFile)}\\n\\1\\n$`,
      ),
    );
  });

  it('fails the step on findings at or above fail-on', async () => {
    const code = await runAction(
      env({ path: fixture('vulnerable-repo'), 'sarif-file': path.join(temp, 'a.sarif') }),
      io(),
    );
    expect(code).toBe(EXIT_FINDINGS);
  });

  it('treats a path that looks like an option as a path', async () => {
    const code = await runAction(
      env({ path: '--json', 'sarif-file': path.join(temp, 'a.sarif') }),
      io(),
    );
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toMatch(/^devsweep: Path does not exist: .*--json\n$/);
  });

  it('reports a bad fail-on value as a tool error, without setting the output', async () => {
    const code = await runAction(
      env({
        path: fixture('clean-repo'),
        'fail-on': 'urgent',
        'sarif-file': path.join(temp, 'a.sarif'),
      }),
      io(),
    );
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toContain("argument 'urgent' is invalid");
    await expect(readFile(path.join(temp, 'github-output'), 'utf8')).rejects.toThrow();
  });

  /** A SARIF file left over from an earlier run, last changed a day ago. */
  async function oldSarifFile(): Promise<string> {
    const file = path.join(temp, 'old.sarif');
    await writeFile(file, '{"old": true}\n');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(file, yesterday, yesterday);
    return file;
  }

  it("doesn't point the output at an old SARIF file that this run didn't write", async () => {
    const sarifFile = await oldSarifFile();
    const code = await runAction(
      env({ path: path.join(temp, 'does-not-exist'), 'sarif-file': sarifFile }),
      io(),
    );
    expect(code).toBe(EXIT_TOOL_ERROR);
    await expect(readFile(path.join(temp, 'github-output'), 'utf8')).rejects.toThrow();
  });

  it('sets the output when this run replaces an old SARIF file', async () => {
    const sarifFile = await oldSarifFile();
    await runAction(env({ path: fixture('clean-repo'), 'sarif-file': sarifFile }), io());
    expect(await readFile(path.join(temp, 'github-output'), 'utf8')).toContain(sarifFile);
  });

  it('falls back to the defaults for empty inputs', async () => {
    const sarifFile = path.join(temp, 'a.sarif');
    const code = await runAction(
      env({ path: fixture('clean-repo'), 'fail-on': '  ', 'sarif-file': sarifFile }),
      io(),
    );
    expect(code).toBe(EXIT_OK);
  });
});

describe('action.yml', () => {
  it('declares the inputs, defaults and output that runAction uses', async () => {
    const action = parse(await readFile(path.join(fixture('..'), '..', 'action.yml'), 'utf8'));
    expect(action.runs).toEqual({ using: 'node24', main: 'action/main.mjs' });
    expect(Object.keys(action.inputs)).toEqual(['path', 'fail-on', 'sarif-file']);
    expect(action.inputs.path.default).toBe('.');
    expect(action.inputs['fail-on'].default).toBe('low');
    expect(action.inputs['sarif-file'].default).toBe('devsweep.sarif');
    expect(Object.keys(action.outputs)).toEqual(['sarif-file']);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
