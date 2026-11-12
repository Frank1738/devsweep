import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/checks/workflows/pull-request-target.js';
import { workflow } from '../helpers.js';

function checkoutWorkflow(ref: string, trigger = 'pull_request_target'): string {
  return `
    on: ${trigger}
    jobs:
      test:
        steps:
          - uses: actions/checkout@v4
            with:
              ref: ${ref}
  `;
}

describe('pull_request_target rules', () => {
  it('ignores workflows without pull_request_target', () => {
    const wf = workflow(
      checkoutWorkflow('${{ github.event.pull_request.head.sha }}', 'pull_request'),
    );
    expect(analyze(wf)).toEqual([]);
  });

  it('flags the trigger alone as medium, at the trigger', () => {
    const findings = analyze(
      workflow(`
        on:
          pull_request_target:
            types: [labeled]
        jobs:
          label:
            steps:
              - uses: actions/labeler@v5
      `),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'workflow/pull-request-target',
        severity: 'medium',
        line: 2,
        column: 3,
      }),
    ]);
  });

  it.each([
    '${{ github.event.pull_request.head.sha }}',
    '${{ github.event.pull_request.head.ref }}',
    '${{ github.head_ref }}',
    'refs/pull/${{ github.event.number }}/merge',
  ])('flags checking out %s as critical, at the ref, without a duplicate medium', (ref) => {
    const findings = analyze(workflow(checkoutWorkflow(ref)));
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'workflow/untrusted-checkout',
        severity: 'critical',
        line: 7,
        column: 16,
      }),
    ]);
    expect(findings[0]?.message).toContain('Job "test"');
  });

  it('does not treat a checkout of the base branch as untrusted', () => {
    const findings = analyze(workflow(checkoutWorkflow('main')));
    expect(findings.map((f) => f.ruleId)).toEqual(['workflow/pull-request-target']);
  });

  it.each([
    'gh pr checkout ${{ github.event.number }}',
    'git fetch origin ${{ github.event.pull_request.head.sha }}',
    'git fetch origin pull/1/head:pr && git checkout refs/pull/1/head',
  ])('flags a run step that fetches the pull request, at that line: %s', (command) => {
    const findings = analyze(
      workflow(`
        on: pull_request_target
        jobs:
          test:
            steps:
              - run: |
                  echo "building"
                  ${command}
      `),
    );
    expect(findings.map((f) => [f.ruleId, f.line])).toEqual([['workflow/untrusted-checkout', 7]]);
  });

  it('does not flag run steps that only mention the head ref', () => {
    const findings = analyze(
      workflow(`
        on: pull_request_target
        jobs:
          test:
            steps:
              - run: echo "Branch is \${{ github.head_ref }}"
      `),
    );
    expect(findings.map((f) => f.ruleId)).toEqual(['workflow/pull-request-target']);
  });
});
