import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { EXIT_FINDINGS, EXIT_OK, EXIT_TOOL_ERROR } from '../src/exit-code.js';
import { VERSION } from '../src/version.js';
import { BASE, fakeGitHub, protectedRepo } from './fake-github.js';
import { fixture } from './helpers.js';

/** Runs the CLI offline, as most tests don't concern the GitHub checks. */
function run(...argv: string[]) {
  const asksForInfo = argv.includes('--version') || argv.includes('--help');
  return runOnline(asksForInfo ? argv : [...argv, '--offline'], {});
}

/** Runs the CLI with the GitHub checks on, a given environment, and a fake fetch. */
async function runOnline(
  argv: string[],
  env: Record<string, string>,
  fetch: typeof globalThis.fetch = () => Promise.reject(new Error('no network in tests')),
) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: false,
    interactive: false,
    env,
    fetch,
  });
  return { code, stdout, stderr };
}

function lastLines(text: string, count: number): string[] {
  return text.trimEnd().split('\n').slice(-count);
}

describe('devsweep scan', () => {
  it('prints one line per finding, grouped by file, with a summary', async () => {
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'));
    expect(code).toBe(EXIT_FINDINGS);
    expect(stdout).toContain(
      '  .github/workflows/pr-preview.yml\n' +
        '    ● critical  14  Runs pull request code with secrets   job preview\n',
    );
    expect(lastLines(stdout, 2)).toEqual([
      expect.stringMatching(
        /^ {2}10 issues {2}1 critical {2}6 high {2}2 medium {2}1 low {2}· \d+ ms$/,
      ),
      '  Add --details to see why each one matters and how to fix it.',
    ]);
  });

  it('scans when no command is given, since scan is the default', async () => {
    const { code, stdout } = await run(fixture('vulnerable-repo'));
    expect(code).toBe(EXIT_FINDINGS);
    expect(stdout).toContain('10 issues');
  });

  it('explains each finding with a code excerpt and fix when asked for --details', async () => {
    const { stdout } = await run('scan', fixture('vulnerable-repo'), '--details');
    expect(stdout).toContain('    ● critical  Runs pull request code with secrets  line 14');
    expect(stdout).toContain('      14 │           ref: ${{ github.event.pull_request.head.sha }}');
    expect(stdout).toMatch(/^ {9}│ {16}\^{41}$/m);
    expect(stdout).toContain('      Fix: Switch to the pull_request trigger');
    expect(stdout).not.toContain('Add --details');
  });

  it('prints no color codes when color is off', async () => {
    const { stdout } = await run('scan', fixture('vulnerable-repo'), '--details');
    expect(stdout).not.toContain('\u001b[');
  });

  it('accepts --no-color', async () => {
    const { code } = await run('scan', fixture('clean-repo'), '--no-color');
    expect(code).toBe(EXIT_OK);
  });

  it('says so when there is nothing to report', async () => {
    const { stdout } = await run('scan', fixture('clean-repo'));
    expect(lastLines(stdout, 1)[0]).toMatch(/^ {2}● No issues found {2}· \d+ ms$/);
  });

  it('shows skipped files, and counts them as warnings in the summary', async () => {
    const { stdout } = await run('scan', fixture('invalid-yaml'));
    expect(stdout).toContain('  ! .github/workflows/broken.yml  Skipped invalid YAML');
    expect(lastLines(stdout, 1)[0]).toMatch(/No issues found {2}· 1 warning {2}· \d+ ms$/);
  });

  it('prints JSON with --json', async () => {
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'), '--json');
    expect(code).toBe(EXIT_FINDINGS);
    const report = JSON.parse(stdout);
    expect(report.tool).toEqual({ name: 'devsweep', version: VERSION });
    expect(report.summary).toEqual({
      total: 10,
      critical: 1,
      high: 6,
      medium: 2,
      low: 1,
      accepted: 0,
    });
    expect(report.findings[0]).toMatchObject({
      ruleId: 'workflow/untrusted-checkout',
      subject: 'job preview',
      file: '.github/workflows/pr-preview.yml',
      line: 14,
      column: 16,
    });
  });

  it('exits with a tool error for a missing path', async () => {
    const { code, stdout, stderr } = await run('scan', fixture('does-not-exist'));
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^devsweep: Path does not exist: /);
  });

  it('animates, then reveals the report line by line, in an interactive terminal', async () => {
    const writes: string[] = [];
    const code = await main([fixture('clean-repo'), '--offline'], {
      stdout: (text) => writes.push(text),
      stderr: () => {},
      color: false,
      interactive: true,
    });
    expect(code).toBe(EXIT_OK);
    expect(writes[0]).toBe('\u001b[?25l');
    expect(writes.some((w) => w.includes('devsweep  ····'))).toBe(true);
    const report = writes.slice(writes.lastIndexOf('\u001b[?25h') + 1);
    expect(report.every((w) => w.endsWith('\n') && w.split('\n').length === 2)).toBe(true);
    expect(report.join('')).toContain('No issues found');
  });

  it('draws the banner first when the terminal is wide enough, without repeating the name', async () => {
    const writes: string[] = [];
    await main([fixture('clean-repo'), '--offline'], {
      stdout: (text) => writes.push(text),
      stderr: () => {},
      color: false,
      interactive: true,
      width: 100,
    });
    const output = writes.join('');
    const bannerAt = output.indexOf('██████╗ ███████╗');
    const resultsAt = output.indexOf('  Results for ');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(resultsAt).toBeGreaterThan(bannerAt);
    expect(output).toContain('supply-chain & credential risk scanner');
    expect(output).not.toContain('\n  devsweep  ');
  });

  it('shows the banner on --help in a wide terminal', async () => {
    let stdout = '';
    await main(['--help'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      color: false,
      interactive: true,
      width: 100,
    });
    expect(stdout.indexOf('██████╗')).toBeLessThan(stdout.indexOf('Usage: devsweep'));
  });

  it('prints the version', async () => {
    const { code, stdout } = await run('--version');
    expect(code).toBe(EXIT_OK);
    expect(stdout.trim()).toBe(VERSION);
  });
});

describe('devsweep scan --sarif and --output', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-cli-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('prints SARIF with --sarif', async () => {
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'), '--sarif');
    expect(code).toBe(EXIT_FINDINGS);
    const sarif = JSON.parse(stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver).toMatchObject({ name: 'devsweep', version: VERSION });
    expect(sarif.runs[0].results).toHaveLength(10);
  });

  it('prints only plain SARIF to stdout, even in an interactive terminal', async () => {
    let stdout = '';
    await main([fixture('vulnerable-repo'), '--sarif', '--offline'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      color: true,
      interactive: true,
      width: 100,
    });
    expect(stdout).not.toContain('\u001b[');
    expect(JSON.parse(stdout).runs[0].results).toHaveLength(10);
  });

  it('rejects --sarif with --json', async () => {
    const { code, stdout, stderr } = await run('scan', fixture('clean-repo'), '--sarif', '--json');
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain("option '--sarif' cannot be used with option '--json'");
  });

  it('rejects --output without --json or --sarif', async () => {
    const out = path.join(temp, 'report.txt');
    const { code, stderr } = await run('scan', fixture('clean-repo'), '-o', out);
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toContain('--output needs --json or --sarif');
  });

  it('saves SARIF with --output, creating folders, and still shows the readable report', async () => {
    const out = path.join(temp, 'reports', 'devsweep.sarif');
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'), '--sarif', '-o', out);
    expect(code).toBe(EXIT_FINDINGS);
    expect(JSON.parse(await readFile(out, 'utf8')).runs[0].results).toHaveLength(10);
    expect(stdout).toContain('10 issues');
    expect(lastLines(stdout, 1)).toEqual([`  SARIF report saved to ${out}`]);
  });

  it('saves JSON with --output', async () => {
    const out = path.join(temp, 'devsweep.json');
    const { code, stdout } = await run(
      'scan',
      fixture('vulnerable-repo'),
      '--json',
      '--output',
      out,
    );
    expect(code).toBe(EXIT_FINDINGS);
    expect(JSON.parse(await readFile(out, 'utf8')).summary.total).toBe(10);
    expect(lastLines(stdout, 1)).toEqual([`  JSON report saved to ${out}`]);
  });

  it('exits with a tool error when the report can’t be saved', async () => {
    const { code, stderr } = await run('scan', fixture('clean-repo'), '--sarif', '-o', temp);
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toMatch(/^devsweep: Couldn't save the report to /);
  });

  it('writes SARIF paths from the repository root when scanning a subfolder', async () => {
    const workflows = path.join(temp, 'tools', '.github', 'workflows');
    await mkdir(path.join(temp, '.git'));
    await mkdir(workflows, { recursive: true });
    await writeFile(
      path.join(workflows, 'ci.yml'),
      'on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - uses: example-org/x@v1\n',
    );
    const { stdout } = await run('scan', path.join(temp, 'tools'), '--sarif');
    const [result] = JSON.parse(stdout).runs[0].results;
    expect(result.locations[0].physicalLocation.artifactLocation).toEqual({
      uri: 'tools/.github/workflows/ci.yml',
      uriBaseId: '%SRCROOT%',
    });
  });
});

describe('devsweep scan --fail-on and exit codes', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-exit-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  /** A repository whose only finding is medium: a pull_request_target trigger with no checkout. */
  async function mediumOnlyRepo(): Promise<string> {
    const workflows = path.join(temp, '.github', 'workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(
      path.join(workflows, 'label.yml'),
      'on: pull_request_target\npermissions:\n  contents: read\njobs:\n  label:\n' +
        '    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/labeler@v5\n',
    );
    return temp;
  }

  it('fails on any finding by default, and still prints the report', async () => {
    const { code, stdout } = await run('scan', await mediumOnlyRepo());
    expect(code).toBe(EXIT_FINDINGS);
    expect(stdout).toContain('1 issue  1 medium');
  });

  it.each([
    ['critical', EXIT_OK],
    ['high', EXIT_OK],
    ['medium', EXIT_FINDINGS],
    ['low', EXIT_FINDINGS],
    ['none', EXIT_OK],
  ])('exits as expected with --fail-on %s and one medium finding', async (failOn, expected) => {
    const { code } = await run('scan', await mediumOnlyRepo(), '--fail-on', failOn);
    expect(code).toBe(expected);
  });

  it('never fails with --fail-on none, even on a critical finding', async () => {
    const { code } = await run('scan', fixture('vulnerable-repo'), '--fail-on', 'none');
    expect(code).toBe(EXIT_OK);
  });

  it('applies the threshold to --json and --sarif output too', async () => {
    const json = await run('scan', fixture('vulnerable-repo'), '--json', '--fail-on', 'none');
    const sarif = await run('scan', fixture('vulnerable-repo'), '--sarif');
    expect(json.code).toBe(EXIT_OK);
    expect(sarif.code).toBe(EXIT_FINDINGS);
  });

  it('does not fail when files were only skipped', async () => {
    const { code } = await run('scan', fixture('invalid-yaml'));
    expect(code).toBe(EXIT_OK);
  });

  it('rejects an unknown severity with a tool error', async () => {
    const { code, stderr } = await run('scan', fixture('clean-repo'), '--fail-on', 'severe');
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toContain('Allowed choices are critical, high, medium, low, none');
  });

  it('exits with a tool error for an unknown option', async () => {
    const { code, stderr } = await run('scan', fixture('clean-repo'), '--nope');
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stderr).toContain("unknown option '--nope'");
  });

  it('exits 0 for --help', async () => {
    const { code, stdout } = await run('scan', '--help');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('--fail-on <severity>');
  });
});

describe('devsweep scan with devsweep.config.json', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-config-cli-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('leaves accepted findings out of the list, and counts them in the summary', async () => {
    const { code, stdout } = await run('scan', fixture('configured-repo'));
    expect(code).toBe(EXIT_FINDINGS);
    expect(stdout).not.toContain('setup-tool');
    expect(stdout).toContain(
      '  ! devsweep.config.json  accept[2] matches no finding (workflow/force-push in ' +
        '.github/workflows/pages.yml). Remove it if the issue was fixed.',
    );
    expect(lastLines(stdout, 2)[0]).toMatch(
      /^ {2}2 issues {2}1 high {2}1 low {2}· 2 accepted {2}· 1 warning {2}· \d+ ms$/,
    );
  });

  it('passes when every finding is accepted', async () => {
    const workflows = path.join(temp, '.github', 'workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(
      path.join(workflows, 'label.yml'),
      'on: pull_request_target\npermissions: {}\njobs:\n  a:\n    steps:\n      - run: echo\n',
    );
    await writeFile(
      path.join(temp, 'devsweep.config.json'),
      JSON.stringify({
        accept: [
          {
            rule: 'workflow/pull-request-target',
            file: '.github/workflows/label.yml',
            reason: 'Never runs pull request code.',
          },
        ],
      }),
    );
    const { code, stdout } = await run('scan', temp);
    expect(code).toBe(EXIT_OK);
    expect(lastLines(stdout, 1)[0]).toMatch(/^ {2}● No issues found {2}· 1 accepted {2}· \d+ ms$/);
  });

  it('lists accepted findings in JSON, with their reasons', async () => {
    const { stdout } = await run('scan', fixture('configured-repo'), '--json');
    const report = JSON.parse(stdout);
    expect(report.summary).toMatchObject({ total: 2, accepted: 2 });
    expect(report.accepted[0]).toMatchObject({
      ruleId: 'workflow/unpinned-action',
      subject: 'example-org/setup-tool@v3',
      reason: 'Our own action, released from a protected tag.',
    });
  });

  it('marks accepted findings as suppressed in SARIF, with the reason', async () => {
    const { stdout } = await run('scan', fixture('configured-repo'), '--sarif');
    const results = JSON.parse(stdout).runs[0].results;
    expect(results).toHaveLength(4);
    expect(results.filter((r: { suppressions?: unknown }) => r.suppressions)).toEqual([
      expect.objectContaining({
        ruleId: 'workflow/unpinned-action',
        suppressions: [
          {
            kind: 'external',
            status: 'accepted',
            justification: 'Our own action, released from a protected tag.',
          },
        ],
      }),
      expect.objectContaining({ ruleId: 'workflow/pull-request-target' }),
    ]);
  });

  it('exits with a tool error and a clear message for an invalid config file', async () => {
    await writeFile(path.join(temp, 'devsweep.config.json'), '{ "accept": [{ "rule": 1 }] }');
    const { code, stdout, stderr } = await run('scan', temp);
    expect(code).toBe(EXIT_TOOL_ERROR);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'devsweep: devsweep.config.json: accept[0]: "reason" is required. Say why this finding is acceptable.\n',
    );
  });
});

describe('devsweep scan: GitHub repository checks', () => {
  const TOKEN = 'ghp_FAKE0000000000000000000000000000000';
  const env = { GITHUB_REPOSITORY: 'octo/demo', GITHUB_TOKEN: TOKEN };
  const unprotectedMain = () => ({
    ...protectedRepo(),
    [`${BASE}/rules/branches/main`]: [],
    [`${BASE}/branches/main`]: { protected: false },
  });

  /**
   * A clone of octo/demo, the repository the fake GitHub serves. The fixtures sit inside
   * devsweep's own clone, whose origin remote would win over GITHUB_REPOSITORY.
   */
  let clone: string;

  beforeEach(async () => {
    clone = await mkdtemp(path.join(os.tmpdir(), 'devsweep-clone-'));
    await mkdir(path.join(clone, '.git'));
    await writeFile(
      path.join(clone, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/octo/demo.git\n',
    );
  });

  afterEach(async () => {
    await rm(clone, { recursive: true, force: true });
  });

  it("warns that it couldn't check when there is no token, without failing", async () => {
    const { code, stdout } = await runOnline(['scan', fixture('clean-repo')], {});
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("  ! Couldn't check GitHub repository settings");
    expect(lastLines(stdout, 1)[0]).toMatch(/No issues found {2}· 1 warning {2}· \d+ ms$/);
  });

  it('lists repository findings under their own heading, and fails on them', async () => {
    const { fetch } = fakeGitHub(unprotectedMain());
    const { code, stdout, stderr } = await runOnline(['scan', clone], env, fetch);
    expect(code).toBe(EXIT_FINDINGS);
    expect(stdout).toMatch(
      / {2}GitHub repository settings\n {4}● high +Force pushes allowed +branch main\n/,
    );
    expect(stdout + stderr).not.toContain(TOKEN);
  });

  it('gives repository findings a placeholder location in SARIF', async () => {
    const { fetch } = fakeGitHub(unprotectedMain());
    const { stdout } = await runOnline(['scan', clone, '--sarif'], env, fetch);
    const [result] = JSON.parse(stdout).runs[0].results;
    expect(result.ruleId).toBe('repo/force-push-allowed');
    expect(result.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: 'github-repository-settings', uriBaseId: '%SRCROOT%' },
      region: { startLine: 1 },
    });
  });

  it('can accept a repository finding in the config file, without a file', async () => {
    const { fetch } = fakeGitHub(unprotectedMain());
    const temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-repo-config-'));
    try {
      await writeFile(
        path.join(temp, 'devsweep.config.json'),
        JSON.stringify({
          accept: [
            {
              rule: 'repo/force-push-allowed',
              subject: 'branch main',
              reason: 'Solo sandbox repo.',
            },
          ],
        }),
      );
      const { code, stdout } = await runOnline(['scan', temp], env, fetch);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toContain('No issues found  · 1 accepted');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('skips them entirely with --offline', async () => {
    const github = fakeGitHub(unprotectedMain());
    const { code, stdout } = await runOnline(
      ['scan', fixture('clean-repo'), '--offline'],
      env,
      github.fetch,
    );
    expect(code).toBe(EXIT_OK);
    expect(github.calls).toEqual([]);
    expect(stdout).not.toContain('warning');
  });
});
