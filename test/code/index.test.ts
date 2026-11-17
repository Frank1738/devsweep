import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeCheck } from '../../src/checks/code/index.js';
import type { ScanContext } from '../../src/types.js';

const WATCHER = JSON.stringify({
  version: '2.0.0',
  tasks: [{ label: 'watch', command: 'npm run watch', runOptions: { runOn: 'folderOpen' } }],
});

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-code-'));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function create(files: Record<string, string>): Promise<void> {
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(temp, name)), { recursive: true });
    await writeFile(path.join(temp, name), source);
  }
}

async function run() {
  const warnings: { file: string | undefined; message: string }[] = [];
  const ctx: ScanContext = {
    root: temp,
    warn: (message, file) => warnings.push({ file, message }),
    scannedFile: () => {},
    scannedGitHub: () => {},
    repository: async () => undefined,
    offline: true,
    env: {},
    fetch: globalThis.fetch,
  };
  const findings = await codeCheck.run(ctx);
  return { findings, warnings };
}

describe('codeCheck', () => {
  it('reports nothing, and warns about nothing, without .vscode/tasks.json', async () => {
    expect(await run()).toEqual({ findings: [], warnings: [] });
  });

  it('reports nothing when .vscode is a file, not a folder', async () => {
    await create({ '.vscode': 'not a folder' });
    expect(await run()).toEqual({ findings: [], warnings: [] });
  });

  it('skips invalid JSONC with a warning that names the file and the place', async () => {
    await create({ '.vscode/tasks.json': '{\n  "tasks": [\n    { "label": "x" \n' });
    expect(await run()).toEqual({
      findings: [],
      warnings: [
        {
          file: '.vscode/tasks.json',
          message: 'Skipped invalid JSONC: Unexpected end of file at line 4, column 1',
        },
      ],
    });
  });

  it('reports an auto-run task', async () => {
    await create({ '.vscode/tasks.json': WATCHER });
    const { findings, warnings } = await run();
    expect(warnings).toEqual([]);
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'code/autorun-task',
        severity: 'medium',
        subject: 'watch',
      }),
    ]);
  });

  it.each([
    ['flat', '{ "task.allowAutomaticTasks": "on" }', 'high'],
    ['nested', '{ "task": { "allowAutomaticTasks": "on" } }', 'high'],
    ['with comments', '{\n  // allow\n  "task.allowAutomaticTasks": "on",\n}', 'high'],
    ['set to off', '{ "task.allowAutomaticTasks": "off" }', 'medium'],
    ['set to prompt', '{ "task.allowAutomaticTasks": "prompt" }', 'medium'],
    ['not set', '{ "editor.tabSize": 2 }', 'medium'],
  ])('reads allowAutomaticTasks from settings.json (%s)', async (_, settings, severity) => {
    await create({ '.vscode/tasks.json': WATCHER, '.vscode/settings.json': settings });
    const { findings, warnings } = await run();
    expect(warnings).toEqual([]);
    expect(findings).toEqual([expect.objectContaining({ severity })]);
  });

  it('still reports tasks when settings.json is invalid, with a warning', async () => {
    await create({ '.vscode/tasks.json': WATCHER, '.vscode/settings.json': '{ oops }' });
    const { findings, warnings } = await run();
    expect(findings).toEqual([expect.objectContaining({ severity: 'medium' })]);
    expect(warnings).toEqual([
      {
        file: '.vscode/settings.json',
        message: expect.stringMatching(
          /^Couldn't read "task.allowAutomaticTasks", invalid JSONC: /,
        ),
      },
    ]);
  });

  it("doesn't read settings.json when there are no tasks", async () => {
    await create({ '.vscode/settings.json': '{ oops }' });
    expect(await run()).toEqual({ findings: [], warnings: [] });
  });
});
