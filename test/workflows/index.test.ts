import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowsCheck } from '../../src/checks/workflows/index.js';
import type { ScanContext } from '../../src/types.js';

/** Absolute paths that fail to read, as if access were denied. */
const unreadable = vi.hoisted(() => new Set<string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      unreadable.has(String(args[0]))
        ? Promise.reject(
            Object.assign(new Error(`EACCES: permission denied, open '${args[0]}'`), {
              code: 'EACCES',
            }),
          )
        : actual.readFile(...args),
  };
});

/** One finding: the job gets the default token permissions. */
const VALID = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
const INVALID = 'on: push\njobs:\n  build:\n    steps: [unclosed\n';

let temp: string;
let dir: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-workflows-'));
  dir = path.join(temp, '.github', 'workflows');
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  unreadable.clear();
  await rm(temp, { recursive: true, force: true });
});

/** Creates the files one at a time, in the order given. */
async function create(files: [name: string, source: string][]): Promise<void> {
  for (const [name, source] of files) await writeFile(path.join(dir, name), source);
}

function context() {
  const warnings: { file: string | undefined; message: string }[] = [];
  const ctx: ScanContext = {
    root: temp,
    warn: (message, file) => warnings.push({ file, message }),
    offline: true,
    env: {},
    fetch: globalThis.fetch,
  };
  return { ctx, warnings };
}

// These call the check directly: scan() sorts findings and warnings itself, which would hide the
// check's own order.
describe('workflowsCheck', () => {
  it('reports files in name order by character code, whatever order they were created in', async () => {
    // Capitals sort before lowercase by character code, unlike a case-insensitive order (what
    // Windows file systems use) or localeCompare.
    await create([
      ['deploy.yml', VALID],
      ['Build.yml', INVALID],
      ['ci.yml', VALID],
      ['audit.yml', INVALID],
      ['Release.yml', VALID],
    ]);
    const { ctx, warnings } = context();

    const findings = await workflowsCheck.run(ctx);

    expect(warnings).toEqual([
      {
        file: '.github/workflows/Build.yml',
        message: expect.stringMatching(/^Skipped invalid YAML: /),
      },
      {
        file: '.github/workflows/audit.yml',
        message: expect.stringMatching(/^Skipped invalid YAML: /),
      },
    ]);
    expect(findings.map((f) => `${f.ruleId} ${f.file}`)).toEqual([
      'workflow/missing-permissions .github/workflows/Release.yml',
      'workflow/missing-permissions .github/workflows/ci.yml',
      'workflow/missing-permissions .github/workflows/deploy.yml',
    ]);
  });

  it('rejects for the first unreadable file by name, after warning about the files before it', async () => {
    await create([
      ['d.yml', VALID],
      ['b.yml', VALID],
      ['c.yml', VALID],
      ['a.yml', INVALID],
    ]);
    // Two failures: if the second one went unhandled, the test run would report it.
    unreadable.add(path.join(dir, 'd.yml'));
    unreadable.add(path.join(dir, 'b.yml'));
    const { ctx, warnings } = context();

    await expect(workflowsCheck.run(ctx)).rejects.toMatchObject({
      code: 'EACCES',
      message: expect.stringContaining('b.yml'),
    });
    expect(warnings.map((w) => w.file)).toEqual(['.github/workflows/a.yml']);
  });
});
