import { describe, expect, it } from 'vitest';
import { compareFindings, ScanTargetError, scan } from '../src/scanner.js';
import type { Check, Finding } from '../src/types.js';
import { fixture } from './helpers.js';

describe('scan', () => {
  it('finds every planted problem in the vulnerable fixture, most severe first', async () => {
    const result = await scan({ root: fixture('vulnerable-repo') });
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
    const result = await scan({ root: fixture('clean-repo') });
    expect(result.findings).toEqual([]);
  });

  it('reports nothing for a repository without workflows', async () => {
    const result = await scan({ root: fixture('no-workflows') });
    expect(result).toMatchObject({ findings: [], warnings: [], errors: [] });
  });

  it('skips invalid YAML with a warning instead of failing', async () => {
    const result = await scan({ root: fixture('invalid-yaml') });
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
    await expect(scan({ root: fixture('does-not-exist') })).rejects.toThrow(ScanTargetError);
  });

  it('rejects a path that is a file', async () => {
    await expect(scan({ root: fixture('no-workflows/README.md') })).rejects.toThrow(
      /not a directory/,
    );
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
});
