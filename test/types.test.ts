import { describe, expect, it } from 'vitest';
import { createFinding, type Rule } from '../src/types.js';

const rule: Rule = {
  id: 'test/rule',
  title: 'Test rule',
  severity: 'medium',
  description: 'Why it matters.',
  remediation: 'How to fix it in general.',
};

describe('createFinding', () => {
  it("uses the rule's remediation when the input leaves it out", () => {
    const finding = createFinding(rule, { message: 'Found it.' });

    expect(finding.remediation).toBe('How to fix it in general.');
  });

  it('keeps a remediation the input passes', () => {
    const finding = createFinding(rule, { message: 'Found it.', remediation: 'Fix this one.' });

    expect(finding.remediation).toBe('Fix this one.');
  });
});
