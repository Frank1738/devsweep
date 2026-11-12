import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/checks/workflows/force-push.js';
import { workflow } from '../helpers.js';

/** Runs `command` as the second line of a literal block script, which sits on line 9. */
function run(command: string) {
  return analyze(
    workflow(`
      on: push
      permissions:
        contents: write
      jobs:
        release:
          steps:
            - run: |
                echo "start"
                ${command}
    `),
  );
}

describe('workflow/force-push in run steps', () => {
  it.each([
    ['git push --force origin main', 'high', 'branch "main"'],
    ['git push -f origin master', 'high', 'branch "master"'],
    ['git push -f origin v1', 'high', 'tag "v1"'],
    ['git push --force origin refs/tags/v1.2.3', 'high', 'tag "v1.2.3"'],
    ['git push --force --tags', 'high', 'all tags'],
    ['git push --mirror https://example.com/backup.git', 'high', 'every branch and tag'],
    ['git push origin +main', 'high', 'branch "main"'],
    ['git push --force', 'medium', 'the checked-out branch'],
    ['git push --force-with-lease origin feature/login', 'medium', 'branch "feature/login"'],
    ['git push -fu origin HEAD:refs/heads/release-notes', 'medium', 'branch "release-notes"'],
    ['git push --force origin HEAD:gh-pages', 'low', 'branch "gh-pages"'],
    ['git push origin main +gh-pages', 'low', 'branch "gh-pages"'],
  ])('rates "%s" as %s', (command, severity, target) => {
    const findings = run(command);
    expect(findings).toEqual([
      expect.objectContaining({ ruleId: 'workflow/force-push', severity, line: 9 }),
    ]);
    expect(findings[0]?.message).toContain(`to ${target}`);
  });

  it.each([
    'git push origin main',
    'git push --tags',
    'git push --force-if-includes origin main',
    'git push -o ci.skip origin main',
    'git tag -f v1',
    'echo "git push --force"',
    'git commit -m "force push"',
  ])('ignores "%s"', (command) => {
    expect(run(command)).toEqual([]);
  });

  it('describes the push without quoting it, so tokens in URLs never reach the output', () => {
    const [finding] = run(
      'git push --force https://x-access-token:ghp_example@github.com/o/r.git main',
    );
    expect(finding?.message).toBe(
      'Job "release" force-pushes (--force) to branch "main", which rewrites history on the ' +
        'remote instead of adding to it.',
    );
  });

  it('points at the exact line inside a multi-line script', () => {
    const findings = analyze(
      workflow(`
        on: push
        jobs:
          release:
            steps:
              - run: |
                  git config user.name bot
                  git commit -am "Update" && git push \\
                    --force origin main
                  git push -f origin v2
      `),
    );
    expect(findings.map((f) => [f.line, f.severity])).toEqual([
      [7, 'high'],
      [9, 'high'],
    ]);
  });

  it('points at the value of a one-line run step', () => {
    const findings = analyze(
      workflow(`
        on: push
        jobs:
          docs:
            steps:
              - run: git push --force origin HEAD:gh-pages
      `),
    );
    expect(findings).toEqual([expect.objectContaining({ severity: 'low', line: 5, column: 14 })]);
  });
});

describe('workflow/force-push in push actions', () => {
  const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

  function action(uses: string, inputs: Record<string, string>) {
    const withLines = Object.entries(inputs)
      .map(([key, value]) => `                  ${key}: ${value}`)
      .join('\n');
    return analyze(
      workflow(`
        on: push
        jobs:
          publish:
            steps:
              - uses: ${uses}
                with:
${withLines}
      `),
    );
  }

  it.each([
    [`example-org/push-action@${SHA}`, { force: 'true', branch: 'main' }, 'high'],
    [`example-org/push-action@${SHA}`, { force_with_lease: 'true' }, 'medium'],
    [`example-org/gh-pages-deploy@${SHA}`, { force_orphan: 'true' }, 'low'],
    [`example-org/auto-commit@${SHA}`, { branch: 'gh-pages', push_options: "'--force'" }, 'low'],
  ])('rates %s with %o as %s', (uses, inputs, severity) => {
    expect(action(uses, inputs)).toEqual([
      expect.objectContaining({ ruleId: 'workflow/force-push', severity }),
    ]);
  });

  it('reports at the force input and names it', () => {
    const [finding] = action(`example-org/push-action@${SHA}`, { force: 'true', branch: 'main' });
    expect(finding).toMatchObject({ line: 7 });
    expect(finding?.message).toContain('force-pushes (force: true) to branch "main"');
  });

  it('ignores force: false', () => {
    expect(action(`example-org/push-action@${SHA}`, { force: 'false', branch: 'main' })).toEqual(
      [],
    );
  });
});
