import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { EXIT_FINDINGS, EXIT_OK, EXIT_TOOL_ERROR, exitCodeForAll } from '../src/exit-code.js';
import { nestedIn } from '../src/scan-all.js';
import type { ScanAllResult, ScanResult } from '../src/types.js';
import { fixture } from './helpers.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-all-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Runs the CLI with a GitHub token set and a fetch that records every call, so tests can check
 * that --all never touches the network even when it could.
 */
async function run(argv: string[], io: { interactive?: boolean; width?: number } = {}) {
  let stdout = '';
  let stderr = '';
  const fetched: string[] = [];
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: false,
    interactive: io.interactive ?? false,
    width: io.width,
    env: { GITHUB_TOKEN: 'test-token' },
    fetch: (input) => {
      fetched.push(String(input));
      return Promise.reject(new Error('no network in tests'));
    },
  });
  return { code, stdout, stderr, fetched };
}

/** A folder holding a vulnerable project, a clean one nested in it, and a plain folder. */
async function workspace(): Promise<string> {
  await cp(fixture('vulnerable-repo'), path.join(tmp, 'api'), { recursive: true });
  await cp(fixture('clean-repo'), path.join(tmp, 'api', 'packages', 'site'), { recursive: true });
  await cp(fixture('clean-repo'), path.join(tmp, 'web'), { recursive: true });
  await mkdir(path.join(tmp, 'notes'), { recursive: true });
  await writeFile(path.join(tmp, 'notes', 'todo.txt'), 'nothing here');
  // A project inside node_modules is never found.
  await cp(fixture('vulnerable-repo'), path.join(tmp, 'web', 'node_modules', 'dep'), {
    recursive: true,
  });
  return tmp;
}

describe('devsweep <path> --all', () => {
  it('groups findings by project, then by file, and ends with a summary', async () => {
    const root = await workspace();
    const { code, stdout, fetched } = await run([root, '--all']);

    expect(code).toBe(EXIT_FINDINGS);
    expect(fetched).toEqual([]);
    expect(stdout).toContain('Network checks are off with --all, as if --offline were passed');
    expect(stdout).toContain(
      '  api\n' +
        '    .github/workflows/pr-preview.yml\n' +
        '      ● critical  14  Runs pull request code with secrets   job preview\n',
    );
    // Clean projects are counted but not listed.
    expect(stdout).not.toMatch(/^ {2}web$/m);
    expect(stdout).not.toContain('node_modules');
    expect(stdout).toMatch(
      /^ {2}Scanned 3 projects, 1 with findings {2}· \d+ folders searched {2}· [\d.]+ m?s$/m,
    );
    expect(stdout).toMatch(/^ {2}10 issues {2}1 critical {2}6 high {2}2 medium {2}1 low$/m);
  });

  it('prints one JSON report listing each project, and the note on stderr', async () => {
    const root = await workspace();
    const { code, stdout, stderr, fetched } = await run([root, '--all', '--json']);

    expect(code).toBe(EXIT_FINDINGS);
    expect(fetched).toEqual([]);
    expect(stderr).toContain('Network checks are off with --all');
    const report = JSON.parse(stdout);
    expect(report.offline).toBe(true);
    expect(report.root).toBe(root);
    expect(report.summary).toMatchObject({
      projects: 3,
      projectsWithFindings: 1,
      foldersUnreadable: 0,
      total: 10,
      critical: 1,
    });
    expect(report.projects.map((p: { path: string }) => p.path)).toEqual([
      'api',
      'api/packages/site',
      'web',
    ]);
    const api = report.projects[0];
    expect(api.root).toBe(path.join(root, 'api'));
    expect(api.summary.total).toBe(10);
    expect(api.findings[0]).toMatchObject({
      ruleId: 'workflow/untrusted-checkout',
      file: '.github/workflows/pr-preview.yml',
    });
    expect(report.projects[2].findings).toEqual([]);
  });

  it('shows no progress or animation when not in an interactive terminal', async () => {
    const root = await workspace();
    const { stdout } = await run([root, '--all']);
    expect(stdout).not.toContain('\u001b[');
    expect(stdout).not.toContain('searching');
  });

  it('shows progress in an interactive terminal, but never with --json', async () => {
    const root = await workspace();
    const shown = await run([root, '--all'], { interactive: true });
    expect(shown.stdout).toContain('\u001b[?25l');
    expect(shown.stdout).toMatch(/devsweep {2}(searching|scanning)/);

    const json = await run([root, '--all', '--json'], { interactive: true });
    expect(json.stdout).not.toContain('\u001b[');
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  });

  it('rejects --sarif as a usage error, since SARIF describes one repository', async () => {
    const root = await workspace();
    const { code, stdout, stderr } = await run([root, '--all', '--sarif']);
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain("--sarif can't be used with --all");
  });

  it('says clearly when no projects were found, and exits 0', async () => {
    await mkdir(path.join(tmp, 'photos', '2024'), { recursive: true });
    const { code, stdout } = await run([tmp, '--all']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^ {2}● No projects found {2}· 3 folders searched/m);
    expect(stdout).toContain(
      'devsweep looks for folders that contain .git, .github/workflows or .vscode/tasks.json',
    );
  });

  it('exits 0 when every project is clean', async () => {
    await cp(fixture('clean-repo'), path.join(tmp, 'one'), { recursive: true });
    await cp(fixture('clean-repo'), path.join(tmp, 'two'), { recursive: true });
    const { code, stdout } = await run([tmp, '--all']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^ {2}Scanned 2 projects, none with findings/m);
    expect(stdout).toMatch(/^ {2}● No issues found$/m);
  });

  it('applies --fail-on across every project', async () => {
    const root = await workspace();
    expect((await run([root, '--all', '--fail-on', 'none'])).code).toBe(EXIT_OK);
    expect((await run([root, '--all', '--fail-on', 'critical'])).code).toBe(EXIT_FINDINGS);
  });

  it("uses each project's own config file, and reports a broken one under that project with exit 2", async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'web', 'devsweep.config.json'), '{ not json');
    const { code, stdout } = await run([root, '--all']);
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stdout).toMatch(/^ {2}web\n {4}× devsweep\.config\.json: not valid JSON/m);
    expect(stdout).toContain('Scan incomplete: 1 project had a check fail or a broken config file');
    // The other projects were still scanned.
    expect(stdout).toContain('10 issues');
  });

  it('exits with a tool error for a missing path', async () => {
    const { code, stderr } = await run([path.join(tmp, 'missing'), '--all']);
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toMatch(/^devsweep: Path does not exist: /);
  });

  it('saves the JSON report with --output and still shows the readable one', async () => {
    const root = await workspace();
    const file = path.join(tmp, 'out', 'report.json');
    const { code, stdout } = await run([root, '--all', '--json', '-o', file]);
    expect(code).toBe(EXIT_FINDINGS);
    expect(stdout).toContain('Scanned 3 projects');
    expect(stdout).toContain(`JSON report saved to ${file}`);
  });
});

describe('nested projects', () => {
  /** An outer repository with another one inside it, each holding one padded file. */
  async function nested(): Promise<string> {
    const padded = `ok();${' '.repeat(80)}console.log("fixture");\n`;
    await mkdir(path.join(tmp, 'outer', '.git'), { recursive: true });
    await mkdir(path.join(tmp, 'outer', 'vendor', 'inner', '.git'), { recursive: true });
    await writeFile(path.join(tmp, 'outer', 'a.js'), padded);
    await writeFile(path.join(tmp, 'outer', 'vendor', 'inner', 'b.js'), padded);
    return path.join(tmp, 'outer');
  }

  it('with --all, reports each file once, under the innermost project holding it', async () => {
    const outer = await nested();
    const { stdout } = await run([outer, '--all', '--json']);
    const report = JSON.parse(stdout);
    const files = report.projects.map((p: { path: string; findings: { file: string }[] }) => [
      p.path,
      p.findings.map((f) => f.file),
    ]);
    expect(files).toEqual([
      ['.', ['a.js']],
      ['vendor/inner', ['b.js']],
    ]);
    expect(report.summary.total).toBe(2);
  });

  it('without --all, scans the nested project as part of the one named', async () => {
    const outer = await nested();
    const { stdout } = await run([outer, '--json', '--offline']);
    expect(JSON.parse(stdout).findings.map((f: { file: string }) => f.file)).toEqual([
      'a.js',
      'vendor/inner/b.js',
    ]);
  });
});

describe('nestedIn', () => {
  it('lists the projects inside a folder, as paths from it, and nothing outside it', () => {
    const root = path.resolve(tmp, 'outer');
    const projects = [
      root,
      path.join(root, 'apps', 'web'),
      path.join(root, 'apps', 'web', 'deep'),
      path.join(tmp, 'outer-two'),
      path.join(tmp, 'other'),
      path.join(root, '..notes'),
    ];
    expect(nestedIn(root, projects)).toEqual(['apps/web', 'apps/web/deep', '..notes']);
  });
});

describe('exitCodeForAll', () => {
  const result = (overrides: Partial<ScanResult> = {}): ScanResult => ({
    root: '/x',
    findings: [],
    accepted: [],
    warnings: [],
    errors: [],
    durationMs: 0,
    ...overrides,
  });
  const all = (...results: ScanResult[]): ScanAllResult => ({
    root: '/',
    projects: results.map((r, i) => ({ path: `p${i}`, result: r })),
    foldersSearched: 1,
    unreadable: [],
    durationMs: 0,
  });
  const finding = { ruleId: 'r', severity: 'medium' as const, message: 'm' };
  const crash = { checkId: 'workflows', message: 'boom' };

  it('is 0 with no projects, or only clean ones', () => {
    expect(exitCodeForAll(all(), 'low')).toBe(EXIT_OK);
    expect(exitCodeForAll(all(result(), result()), 'low')).toBe(EXIT_OK);
  });

  it('is 1 when any project has findings at or above --fail-on', () => {
    expect(exitCodeForAll(all(result(), result({ findings: [finding] })), 'low')).toBe(
      EXIT_FINDINGS,
    );
    expect(exitCodeForAll(all(result({ findings: [finding] })), 'high')).toBe(EXIT_OK);
  });

  it('is 2 when a check crashed in any project, even when another has findings', () => {
    expect(
      exitCodeForAll(all(result({ findings: [finding] }), result({ errors: [crash] })), 'low'),
    ).toBe(EXIT_TOOL_ERROR);
  });
});
