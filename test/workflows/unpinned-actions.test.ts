import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/checks/workflows/unpinned-actions.js';
import { workflow } from '../helpers.js';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

function stepUses(uses: string): string {
  return `
    on: push
    jobs:
      build:
        steps:
          - uses: ${uses}
  `;
}

describe('workflow/unpinned-action', () => {
  it.each([
    ['a tag', 'example-org/deploy@v2'],
    ['a branch', 'example-org/deploy@main'],
    ['a short SHA', 'example-org/deploy@3d3c42e'],
    ['an action in a subdirectory', 'example-org/monorepo/actions/deploy@v1'],
  ])('flags a third-party action pinned to %s', (_, uses) => {
    expect(analyze(workflow(stepUses(uses)))).toEqual([
      expect.objectContaining({
        ruleId: 'workflow/unpinned-action',
        severity: 'high',
        line: 5,
        column: 15,
      }),
    ]);
  });

  it('flags an action with no version at all', () => {
    const [finding] = analyze(workflow(stepUses('example-org/deploy')));
    expect(finding?.message).toContain('has no version');
  });

  it('suggests a SHA pin that keeps the tag as a comment', () => {
    const [finding] = analyze(workflow(stepUses('example-org/deploy@v2')));
    expect(finding?.remediation).toBe(
      'Pin it to a full commit SHA: uses: example-org/deploy@<40-character-sha> # v2',
    );
  });

  it.each([
    ['pinned to a full SHA', `example-org/deploy@${SHA}`],
    ['owned by GitHub (actions)', 'actions/checkout@v4'],
    ['owned by GitHub (github)', 'github/codeql-action/init@v3'],
    ['owned by GitHub, any casing', 'Actions/checkout@v4'],
    ['a local action', './.github/actions/setup'],
    ['a container pinned by digest', `docker://alpine@sha256:${'a'.repeat(64)}`],
  ])('ignores an action %s', (_, uses) => {
    expect(analyze(workflow(stepUses(uses)))).toEqual([]);
  });

  it('flags a container image pinned by tag', () => {
    const [finding] = analyze(workflow(stepUses('docker://alpine:3.20')));
    expect(finding?.message).toBe(
      'Container image "docker://alpine:3.20" is not pinned to a digest.',
    );
  });

  it('flags an unpinned reusable workflow, at the job-level uses', () => {
    const findings = analyze(
      workflow(`
        on: push
        jobs:
          build:
            uses: example-org/workflows/.github/workflows/build.yml@main
      `),
    );
    expect(findings).toEqual([expect.objectContaining({ line: 4, column: 11 })]);
  });
});
