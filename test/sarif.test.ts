import { describe, expect, it } from 'vitest';
import { rules } from '../src/checks/index.js';
import { formatSarif, type SarifOptions, toSarif } from '../src/reporters/sarif.js';
import { sourceReader } from '../src/reporters/source.js';
import { scan } from '../src/scanner.js';
import { type Finding, type ScanResult, SEVERITIES, type Severity } from '../src/types.js';
import { fixture } from './helpers.js';

/** A fixed version, so the golden file doesn't change with every release. */
const VERSION = '0.0.0-test';

function result(findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult {
  return { root: '/repo', findings, warnings: [], errors: [], durationMs: 5, ...extra };
}

const finding: Finding = {
  ruleId: 'workflow/unpinned-action',
  severity: 'high',
  message: 'Third-party action "example-org/deploy" is pinned to "v2".',
  subject: 'example-org/deploy@v2',
  file: '.github/workflows/ci.yml',
  line: 2,
  column: 11,
};

/** Line 2 of a fake workflow: the action reference starts at column 11, with trailing spaces. */
const readLines = () => ['steps:', '  - uses: example-org/deploy@v2   '];

function firstResult(input: ScanResult, options: Partial<SarifOptions> = {}) {
  const [first] = toSarif(input, { version: VERSION, ...options }).runs[0].results;
  if (!first) throw new Error('expected a result');
  return first;
}

describe('formatSarif', () => {
  it('matches the golden file for the vulnerable fixture', async () => {
    const scanned = await scan({ root: fixture('vulnerable-repo') });
    const sarif = formatSarif(scanned, { version: VERSION, readLines: sourceReader(scanned.root) });
    await expect(sarif).toMatchFileSnapshot('./golden/vulnerable-repo.sarif');
  });

  it('describes every rule once, in a fixed order, with the fields GitHub requires', () => {
    const { driver } = toSarif(result([]), { version: VERSION }).runs[0].tool;
    expect(driver).toMatchObject({ name: 'devsweep', semanticVersion: VERSION });
    expect(driver.rules.map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
    for (const rule of driver.rules) {
      expect(rule.shortDescription.text).not.toBe('');
      expect(rule.fullDescription.text.length).toBeGreaterThan(0);
      expect(rule.fullDescription.text.length).toBeLessThanOrEqual(1024);
      expect(rule.shortDescription.text.length).toBeLessThanOrEqual(1024);
      expect(rule.help.text).toContain('How to fix: ');
      expect(rule.properties.tags).toContain('security');
      expect(rule.properties['security-severity']).toMatch(/^\d+\.\d$/);
    }
  });

  /** GitHub's bands: over 9.0 is critical, 7.0–8.9 high, 4.0–6.9 medium, 0.1–3.9 low. */
  const BANDS: Record<Severity, { level: string; min: number; max: number }> = {
    critical: { level: 'error', min: 9.1, max: 10 },
    high: { level: 'error', min: 7.0, max: 8.9 },
    medium: { level: 'warning', min: 4.0, max: 6.9 },
    low: { level: 'note', min: 0.1, max: 3.9 },
  };

  it.each(SEVERITIES)('gives %s findings the right level and a score in its band', (severity) => {
    const { level, min, max } = BANDS[severity];
    const sarif = firstResult(result([{ ...finding, severity }]));
    const score = Number(sarif.properties['security-severity']);
    expect(sarif.level).toBe(level);
    expect(score).toBeGreaterThanOrEqual(min);
    expect(score).toBeLessThanOrEqual(max);
  });

  it("sets each result's level from the finding, not the rule's default", async () => {
    const scanned = await scan({ root: fixture('vulnerable-repo') });
    const run = toSarif(scanned, { version: VERSION }).runs[0];
    const forcePush = run.tool.driver.rules.find((rule) => rule.id === 'workflow/force-push');
    expect(forcePush?.defaultConfiguration.level).toBe('error');
    const levels = run.results
      .filter((r) => r.ruleId === 'workflow/force-push')
      .map((r) => [r.level, r.properties['security-severity']]);
    expect(levels).toEqual([
      ['error', '8.0'],
      ['note', '2.0'],
    ]);
  });

  it('points each ruleIndex at the rule with the same id', async () => {
    const scanned = await scan({ root: fixture('vulnerable-repo') });
    const run = toSarif(scanned, { version: VERSION }).runs[0];
    expect(run.results).toHaveLength(10);
    for (const r of run.results) {
      expect(run.tool.driver.rules[r.ruleIndex ?? -1]?.id).toBe(r.ruleId);
    }
  });

  it('highlights from the column to the end of the line’s content', () => {
    const sarif = firstResult(result([finding]), { readLines });
    expect(sarif.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: '.github/workflows/ci.yml', uriBaseId: '%SRCROOT%' },
      region: { startLine: 2, startColumn: 11, endLine: 2, endColumn: 32 },
    });
  });

  it('starts at the first non-blank character when the finding has no column', () => {
    const { column: _, ...withoutColumn } = finding;
    const sarif = firstResult(result([withoutColumn]), { readLines });
    expect(sarif.locations[0]?.physicalLocation.region).toEqual({
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 32,
    });
  });

  it('gives only the start when the file can’t be read', () => {
    const sarif = firstResult(result([finding]), { readLines: () => undefined });
    expect(sarif.locations[0]?.physicalLocation.region).toEqual({ startLine: 2, startColumn: 11 });
  });

  it('leaves out the region when the finding has no line', () => {
    const { line: _, column: __, ...fileOnly } = finding;
    const sarif = firstResult(result([fileOnly]));
    expect(sarif.locations[0]?.physicalLocation.region).toBeUndefined();
  });

  it('writes paths from the repository root, percent-encoded', () => {
    const sarif = firstResult(result([{ ...finding, file: '.github/workflows/my flow.yml' }]), {
      pathFromRepoRoot: 'tools/ci',
    });
    expect(sarif.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      'tools/ci/.github/workflows/my%20flow.yml',
    );
  });

  it('reports skipped files as warnings and crashed checks as errors', () => {
    const run = toSarif(
      result([], {
        warnings: [{ checkId: 'workflows', message: 'Skipped invalid YAML', file: 'a.yml' }],
        errors: [{ checkId: 'secrets', message: 'boom' }],
      }),
      { version: VERSION },
    ).runs[0];
    expect(run.invocations).toEqual([
      {
        executionSuccessful: false,
        toolExecutionNotifications: [
          {
            level: 'warning',
            message: { text: 'Skipped invalid YAML' },
            locations: [
              { physicalLocation: { artifactLocation: { uri: 'a.yml', uriBaseId: '%SRCROOT%' } } },
            ],
            properties: { checkId: 'workflows' },
          },
          {
            level: 'error',
            message: { text: 'Check "secrets" failed, so its findings are missing: boom' },
            properties: { checkId: 'secrets' },
          },
        ],
      },
    ]);
  });

  it('marks a clean scan as successful, with no notifications', () => {
    const run = toSarif(result([]), { version: VERSION }).runs[0];
    expect(run.invocations).toEqual([{ executionSuccessful: true }]);
    expect(run.results).toEqual([]);
  });

  it('keeps absolute paths and timings out of the file', () => {
    const text = formatSarif(
      result([finding], { root: '/home/someone/private-project', durationMs: 4321 }),
      { version: VERSION },
    );
    expect(text).not.toContain('private-project');
    expect(text).not.toContain('4321');
  });

  it('escapes help text so markdown doesn’t swallow placeholders like <sha>', () => {
    const { driver } = toSarif(result([]), { version: VERSION }).runs[0].tool;
    const unpinned = driver.rules.find((rule) => rule.id === 'workflow/unpinned-action');
    expect(unpinned?.help.text).toContain('owner/action@<sha>');
    expect(unpinned?.help.markdown).toContain('owner/action@\\<sha\\>');
  });
});
