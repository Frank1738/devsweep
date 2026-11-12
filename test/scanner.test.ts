import { describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE, type Config } from '../src/config.js';
import { compareFindings, ScanTargetError, scan } from '../src/scanner.js';
import type { Check, Finding, Rule, ScanResult } from '../src/types.js';
import { fixture } from './helpers.js';

describe('scan', () => {
  it('finds every planted problem in the vulnerable fixture, most severe first', async () => {
    const result = await scan({ root: fixture('vulnerable-repo'), offline: true });
    const found = result.findings.map((f) => `${f.severity} ${f.ruleId} ${f.file}:${f.line}`);
    expect(found).toEqual([
      'critical workflow/untrusted-checkout .github/workflows/pr-preview.yml:14',
      'high workflow/unpinned-action .github/workflows/pr-preview.yml:16',
      'high workflow/write-all-permissions .github/workflows/release.yml:7',
      'high workflow/unpinned-action .github/workflows/release.yml:11',
      'high workflow/unpinned-action .github/workflows/release.yml:17',
      'high workflow/unpinned-action .github/workflows/release.yml:18',
      'high workflow/force-push .github/workflows/release.yml:22',
      'medium workflow/pull-request-target .github/workflows/label.yml:3',
      'medium workflow/missing-permissions .github/workflows/pr-preview.yml:9',
      'low workflow/force-push .github/workflows/docs.yml:16',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports nothing for a clean repository', async () => {
    const result = await scan({ root: fixture('clean-repo'), offline: true });
    expect(result.findings).toEqual([]);
  });

  it('reports nothing for a repository without workflows', async () => {
    const result = await scan({ root: fixture('no-workflows'), offline: true });
    expect(result).toMatchObject({ findings: [], warnings: [], errors: [] });
  });

  it('skips invalid YAML with a warning instead of failing', async () => {
    const result = await scan({ root: fixture('invalid-yaml'), offline: true });
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ checkId: 'workflows', file: '.github/workflows/broken.yml' }),
    ]);
  });

  it('keeps going when a check crashes, and records the error', async () => {
    const finding: Finding = { ruleId: 'test/rule', severity: 'low', message: 'ok', file: 'a' };
    const checks: Check[] = [
      { id: 'broken', description: '', rules: [], run: () => Promise.reject(new Error('boom')) },
      { id: 'working', description: '', rules: [], run: () => Promise.resolve([finding]) },
    ];
    const result = await scan({ root: fixture('clean-repo'), checks });
    expect(result.findings).toEqual([finding]);
    expect(result.errors).toEqual([{ checkId: 'broken', message: 'boom' }]);
  });

  it('rejects a path that does not exist', async () => {
    await expect(scan({ root: fixture('does-not-exist'), offline: true })).rejects.toThrow(
      ScanTargetError,
    );
  });

  it('rejects a path that is a file', async () => {
    await expect(scan({ root: fixture('no-workflows/README.md') })).rejects.toThrow(
      /not a directory/,
    );
  });
});

describe('scan: acceptances that match no finding', () => {
  /** A config that accepts one finding per [rule, file] pair. */
  function accepting(...entries: [rule: string, file?: string][]): Config {
    return {
      accept: entries.map(([rule, file]) => ({
        rule,
        ...(file !== undefined && { file }),
        reason: 'Reviewed.',
      })),
      severity: {},
    };
  }

  const unused = (result: ScanResult) =>
    result.warnings.filter((w) => w.checkId === 'config').map((w) => w.message.slice(0, 9));

  const rule: Rule = {
    id: 'test/rule',
    title: 'Test rule',
    severity: 'low',
    description: '',
    remediation: '',
  };

  it('warns about one for a workflow rule, so it can be cleaned up', async () => {
    const result = await scan({
      root: fixture('clean-repo'),
      offline: true,
      config: accepting(['workflow/unpinned-action', '.github/workflows/ci.yml']),
    });
    expect(result.warnings).toEqual([
      {
        checkId: 'config',
        file: CONFIG_FILE,
        message: expect.stringMatching(/^accept\[0\] matches no finding/),
      },
    ]);
  });

  it("doesn't warn with --offline about one for a check that needs the network", async () => {
    const result = await scan({
      root: fixture('clean-repo'),
      offline: true,
      config: accepting(['repo/force-push-detected']),
    });
    expect(result.warnings).toEqual([]);
  });

  it('skips network checks itself with --offline', async () => {
    const run = vi.fn(() => Promise.resolve([]));
    const result = await scan({
      root: fixture('clean-repo'),
      offline: true,
      checks: [{ id: 'online', description: '', network: true, rules: [rule], run }],
      config: accepting([rule.id]),
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  it("doesn't warn when the repository checks couldn't run for lack of a token", async () => {
    const result = await scan({
      root: fixture('clean-repo'),
      env: {},
      config: accepting(['repo/force-push-allowed']),
    });
    expect(result.warnings.map((w) => w.checkId)).toEqual(['repo']);
  });

  it("doesn't warn about one for a check that crashed", async () => {
    const result = await scan({
      root: fixture('clean-repo'),
      checks: [
        { id: 'broken', description: '', rules: [rule], run: () => Promise.reject(new Error('x')) },
      ],
      config: accepting([rule.id, 'a.yml']),
    });
    expect(result.errors).toHaveLength(1);
    expect(unused(result)).toEqual([]);
  });

  it("doesn't warn about any for a check that warned without naming a file", async () => {
    const result = await scan({
      root: fixture('clean-repo'),
      checks: [
        {
          id: 'partial',
          description: '',
          rules: [rule],
          run: async (ctx) => {
            ctx.warn("Couldn't check anything.");
            return [];
          },
        },
      ],
      config: accepting([rule.id, 'a.yml'], [rule.id]),
    });
    expect(unused(result)).toEqual([]);
  });

  it('only spares those for the file a check warned about', async () => {
    const result = await scan({
      root: fixture('clean-repo'),
      checks: [
        {
          id: 'partial',
          description: '',
          rules: [rule],
          run: async (ctx) => {
            ctx.warn("Couldn't check this file.", 'a.yml');
            return [];
          },
        },
      ],
      config: accepting([rule.id, 'a.yml'], [rule.id, 'b.yml'], [rule.id]),
    });
    expect(unused(result)).toEqual(['accept[1]', 'accept[2]']);
  });

  it('spares those for a workflow skipped as invalid YAML, but not for other files', async () => {
    const result = await scan({
      root: fixture('invalid-yaml'),
      offline: true,
      config: accepting(
        ['workflow/unpinned-action', '.github/workflows/broken.yml'],
        ['workflow/unpinned-action', '.github/workflows/other.yml'],
      ),
    });
    expect(unused(result)).toEqual(['accept[1]']);
  });
});

describe('compareFindings', () => {
  const base = { ruleId: 'r', message: '', file: 'a.yml' };

  it('orders by severity, then file, then line', () => {
    const findings: Finding[] = [
      { ...base, severity: 'low', line: 1 },
      { ...base, severity: 'high', file: 'b.yml', line: 1 },
      { ...base, severity: 'high', line: 9 },
      { ...base, severity: 'high', line: 2 },
      { ...base, severity: 'critical', file: 'z.yml' },
    ];
    expect(findings.sort(compareFindings).map((f) => `${f.severity} ${f.file}:${f.line}`)).toEqual([
      'critical z.yml:undefined',
      'high a.yml:2',
      'high a.yml:9',
      'high b.yml:1',
      'low a.yml:1',
    ]);
  });

  it("compares text by code point, so the order doesn't depend on the machine's language", () => {
    const findings: Finding[] = [
      { ...base, severity: 'high', file: 'a.yml' },
      { ...base, severity: 'high', file: 'B.yml' },
      { ...base, severity: 'high', file: 'a.yml', ruleId: 'workflow/a' },
      { ...base, severity: 'high', file: 'a.yml', ruleId: 'Workflow/b' },
    ];
    expect(findings.sort(compareFindings).map((f) => `${f.file} ${f.ruleId}`)).toEqual([
      'B.yml r',
      'a.yml Workflow/b',
      'a.yml r',
      'a.yml workflow/a',
    ]);
  });
});

describe('scan: warnings', () => {
  it('come in a fixed order, however long each check takes', async () => {
    const slow: Check = {
      id: 'a-slow',
      description: '',
      rules: [],
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        ctx.warn('Finished last.');
        return [];
      },
    };
    const fast: Check = {
      id: 'b-fast',
      description: '',
      rules: [],
      run: async (ctx) => {
        ctx.warn('Second file.', 'z.yml');
        ctx.warn('Also second file.', 'z.yml');
        ctx.warn('First file.', 'a.yml');
        return [];
      },
    };
    const result = await scan({ root: fixture('clean-repo'), checks: [slow, fast], config: false });
    expect(result.warnings.map((w) => `${w.checkId} ${w.file ?? '-'} ${w.message}`)).toEqual([
      'a-slow - Finished last.',
      'b-fast a.yml First file.',
      'b-fast z.yml Also second file.',
      'b-fast z.yml Second file.',
    ]);
  });
});
