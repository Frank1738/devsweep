import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/checks/workflows/permissions.js';
import { workflow } from '../helpers.js';

describe('permissions rules', () => {
  it('flags write-all at the top level, at the permissions key', () => {
    const findings = analyze(
      workflow(`
        on: push
        permissions: write-all
        jobs:
          build: {}
      `),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'workflow/write-all-permissions',
        severity: 'high',
        line: 2,
        column: 1,
      }),
    ]);
  });

  it('flags write-all on a job', () => {
    const findings = analyze(
      workflow(`
        on: push
        permissions:
          contents: read
        jobs:
          release:
            permissions: write-all
      `),
    );
    expect(findings).toEqual([
      expect.objectContaining({ ruleId: 'workflow/write-all-permissions', line: 6, column: 5 }),
    ]);
    expect(findings[0]?.message).toContain('Job "release"');
  });

  it('flags missing permissions once per workflow, at the first unrestricted job', () => {
    const findings = analyze(
      workflow(`
        on: push
        jobs:
          lint: {}
          deploy:
            permissions:
              contents: write
          test: {}
      `),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'workflow/missing-permissions',
        severity: 'medium',
        line: 3,
        column: 3,
      }),
    ]);
    expect(findings[0]?.message).toContain(`jobs "lint", "test" don't set their own`);
  });

  it('uses singular wording for one unrestricted job', () => {
    const [finding] = analyze(
      workflow(`
        on: push
        jobs:
          build: {}
      `),
    );
    expect(finding?.message).toContain(`job "build" doesn't set its own, so it gets`);
  });

  it('accepts workflows where every job sets its own permissions', () => {
    const findings = analyze(
      workflow(`
        on: push
        jobs:
          build:
            permissions:
              contents: read
      `),
    );
    expect(findings).toEqual([]);
  });

  it.each(['read-all', '{}'])('accepts top-level permissions: %s', (value) => {
    const findings = analyze(
      workflow(`
        on: push
        permissions: ${value}
        jobs:
          build: {}
      `),
    );
    expect(findings).toEqual([]);
  });
});
