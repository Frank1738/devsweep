import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_TOOL_ERROR, main } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { fixture } from './helpers.js';

async function run(...argv: string[]) {
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
  });
  return { code, stdout, stderr };
}

function lastLines(text: string, count: number): string[] {
  return text.trimEnd().split('\n').slice(-count);
}

describe('devsweep scan', () => {
  it('prints one line per finding, grouped by file, with a summary', async () => {
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'));
    expect(code).toBe(EXIT_OK);
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
    expect(code).toBe(EXIT_OK);
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

  it('shows skipped files, and counts them in the summary', async () => {
    const { stdout } = await run('scan', fixture('invalid-yaml'));
    expect(stdout).toContain('  ! .github/workflows/broken.yml  Skipped invalid YAML');
    expect(lastLines(stdout, 1)[0]).toMatch(/No issues found {2}· 1 skipped {2}· \d+ ms$/);
  });

  it('prints JSON with --json', async () => {
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'), '--json');
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(stdout);
    expect(report.tool).toEqual({ name: 'devsweep', version: VERSION });
    expect(report.summary).toEqual({ total: 10, critical: 1, high: 6, medium: 2, low: 1 });
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
    const code = await main([fixture('clean-repo')], {
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
    await main([fixture('clean-repo')], {
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
    expect(code).toBe(EXIT_OK);
    const sarif = JSON.parse(stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver).toMatchObject({ name: 'devsweep', version: VERSION });
    expect(sarif.runs[0].results).toHaveLength(10);
  });

  it('prints only plain SARIF to stdout, even in an interactive terminal', async () => {
    let stdout = '';
    await main([fixture('vulnerable-repo'), '--sarif'], {
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
    expect(code).not.toBe(EXIT_OK);
    expect(stdout).toBe('');
    expect(stderr).toContain("option '--sarif' cannot be used with option '--json'");
  });

  it('rejects --output without --json or --sarif', async () => {
    const out = path.join(temp, 'report.txt');
    const { code, stderr } = await run('scan', fixture('clean-repo'), '-o', out);
    expect(code).not.toBe(EXIT_OK);
    expect(stderr).toContain('--output needs --json or --sarif');
  });

  it('saves SARIF with --output, creating folders, and still shows the readable report', async () => {
    const out = path.join(temp, 'reports', 'devsweep.sarif');
    const { code, stdout } = await run('scan', fixture('vulnerable-repo'), '--sarif', '-o', out);
    expect(code).toBe(EXIT_OK);
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
    expect(code).toBe(EXIT_OK);
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
