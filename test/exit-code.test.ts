import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAIL_ON,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_TOOL_ERROR,
  exitCodeFor,
  FAIL_ON,
  failingFindings,
} from '../src/exit-code.js';
import type { Finding, ScanResult, Severity } from '../src/types.js';

function finding(severity: Severity): Finding {
  return { ruleId: 'test/rule', severity, message: 'test', file: 'a.yml' };
}

function result(findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult {
  return {
    root: '/repo',
    findings,
    accepted: [],
    warnings: [],
    errors: [],
    durationMs: 1,
    ...extra,
  };
}

const oneOfEach = (['critical', 'high', 'medium', 'low'] as const).map(finding);

describe('failingFindings', () => {
  it.each([
    ['critical', ['critical']],
    ['high', ['critical', 'high']],
    ['medium', ['critical', 'high', 'medium']],
    ['low', ['critical', 'high', 'medium', 'low']],
    ['none', []],
  ] as const)('counts findings at or above %s', (failOn, expected) => {
    expect(failingFindings(oneOfEach, failOn).map((f) => f.severity)).toEqual(expected);
  });
});

describe('exitCodeFor', () => {
  it('offers every severity plus none, and fails on any finding by default', () => {
    expect(FAIL_ON).toEqual(['critical', 'high', 'medium', 'low', 'none']);
    expect(DEFAULT_FAIL_ON).toBe('low');
  });

  it('exits 0 when nothing is found', () => {
    expect(exitCodeFor(result([]), 'low')).toBe(EXIT_OK);
  });

  it('exits 1 when a finding is at or above the threshold', () => {
    expect(exitCodeFor(result([finding('medium')]), 'medium')).toBe(EXIT_FINDINGS);
  });

  it('exits 0 when every finding is below the threshold', () => {
    expect(exitCodeFor(result([finding('low'), finding('medium')]), 'high')).toBe(EXIT_OK);
  });

  it('exits 0 with --fail-on none, even on a critical finding', () => {
    expect(exitCodeFor(result([finding('critical')]), 'none')).toBe(EXIT_OK);
  });

  it('exits 2 when a check crashed, even with findings or --fail-on none', () => {
    const crashed = result([finding('critical')], { errors: [{ checkId: 'x', message: 'boom' }] });
    expect(exitCodeFor(crashed, 'low')).toBe(EXIT_TOOL_ERROR);
    expect(exitCodeFor(crashed, 'none')).toBe(EXIT_TOOL_ERROR);
  });

  it('does not fail on skipped files alone', () => {
    const skipped = result([], { warnings: [{ checkId: 'x', message: 'Skipped', file: 'a.yml' }] });
    expect(exitCodeFor(skipped, 'low')).toBe(EXIT_OK);
  });
});
