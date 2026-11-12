import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refPatternMatches } from '../src/checks/repo/api.js';
import { repoCheck } from '../src/checks/repo/index.js';
import type { Env, ScanContext } from '../src/types.js';
import { BASE, fakeGitHub, protectedRepo, Reply } from './fake-github.js';

const TOKEN = 'ghp_FAKE0000000000000000000000000000000';

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-repo-'));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

type Fetch = typeof globalThis.fetch;

async function check(
  routes: Record<string, unknown>,
  env: Env = { GITHUB_REPOSITORY: 'octo/demo', GITHUB_TOKEN: TOKEN },
  offline = false,
  /** Wraps the fake GitHub's fetch, e.g. to slow some requests down. */
  wrap: (fetch: Fetch) => Fetch = (fetch) => fetch,
) {
  const github = fakeGitHub(routes);
  const warnings: string[] = [];
  const ctx: ScanContext = {
    root: temp,
    warn: (message) => warnings.push(message),
    offline,
    env,
    fetch: wrap(github.fetch),
  };
  const findings = await repoCheck.run(ctx);
  return { findings, warnings, calls: github.calls };
}

const summary = (findings: { ruleId: string; subject?: string }[]) =>
  findings.map((f) => `${f.ruleId} ${f.subject}`);

describe('repo check: when it runs', () => {
  it('finds nothing in a repository that blocks force pushes on main and tags', async () => {
    const { findings, warnings, calls } = await check(protectedRepo());
    expect(findings).toEqual([]);
    expect(warnings).toEqual([]);
    expect(calls.map((c) => c.url.pathname)).toContain(`${BASE}/activity`);
  });

  it('sends the token only in the Authorization header, with a version and user agent', async () => {
    const { calls } = await check(protectedRepo());
    const [first] = calls;
    expect(first?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(first?.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(first?.headers.get('user-agent')).toMatch(/^devsweep\//);
    expect(calls.every((c) => !c.url.href.includes(TOKEN))).toBe(true);
  });

  it('makes no calls and no warnings with --offline', async () => {
    const { findings, warnings, calls } = await check(protectedRepo(), undefined, true);
    expect([findings, warnings, calls]).toEqual([[], [], []]);
  });

  it('warns instead of checking when there is no token', async () => {
    const { findings, warnings, calls } = await check(protectedRepo(), {
      GITHUB_REPOSITORY: 'octo/demo',
    });
    expect(findings).toEqual([]);
    expect(calls).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Couldn't check GitHub repository settings for octo\/demo: no token\. Set GITHUB_TOKEN or GH_TOKEN/,
      ),
    ]);
  });

  it('accepts GH_TOKEN too', async () => {
    const { calls } = await check(protectedRepo(), {
      GITHUB_REPOSITORY: 'octo/demo',
      GH_TOKEN: TOKEN,
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('warns when there is no GitHub repository to check', async () => {
    const { warnings, calls } = await check(protectedRepo(), { GITHUB_TOKEN: TOKEN });
    expect(calls).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Couldn't check GitHub repository settings: no GitHub repository found/,
      ),
    ]);
  });

  it('warns when the token cannot see the repository, without showing the token', async () => {
    const { findings, warnings } = await check({});
    expect(findings).toEqual([]);
    expect(warnings).toEqual([
      "Couldn't check GitHub repository settings for octo/demo: GitHub answered 404: Not Found. " +
        'Check that the token can read this repository.',
    ]);
    expect(warnings.join('')).not.toContain(TOKEN);
  });

  it('warns when GitHub is unreachable or slow', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { warnings } = await check({ [BASE]: new Reply(0, timeout) });
    expect(warnings).toEqual([
      "Couldn't check GitHub repository settings for octo/demo: GitHub didn't answer within 10 seconds",
    ]);
  });

  it('says so when the rate limit is reached', async () => {
    const limited = new Reply(
      403,
      { message: 'API rate limit exceeded' },
      {
        'x-ratelimit-remaining': '0',
      },
    );
    const { warnings } = await check({ [BASE]: limited });
    expect(warnings).toEqual([
      "Couldn't check GitHub repository settings for octo/demo: GitHub API rate limit reached",
    ]);
  });

  it('says so when a secondary rate limit is reached (a retry-after header)', async () => {
    const limited = new Reply(
      403,
      { message: 'You have exceeded a secondary rate limit' },
      { 'retry-after': '60' },
    );
    const { warnings } = await check({ [BASE]: limited });
    expect(warnings).toEqual([
      "Couldn't check GitHub repository settings for octo/demo: GitHub API rate limit reached",
    ]);
  });

  it('uses GITHUB_API_URL when set, as on GitHub Enterprise Server', async () => {
    const { calls } = await check(protectedRepo(), {
      GITHUB_REPOSITORY: 'octo/demo',
      GITHUB_TOKEN: TOKEN,
      GITHUB_API_URL: 'https://ghe.example.com/api/v3',
    });
    expect(calls[0]?.url.href).toBe('https://ghe.example.com/api/v3/repos/octo/demo');
  });
});

describe('repo/force-push-allowed', () => {
  it('flags a default branch with no ruleset and no branch protection', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rules/branches/main`]: [],
      [`${BASE}/branches/main`]: { protected: false },
    };
    const { findings } = await check(routes);
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'repo/force-push-allowed',
        severity: 'high',
        subject: 'branch main',
        message:
          'The default branch "main" can be force-pushed: no ruleset blocks force pushes, and ' +
          'it has no branch protection.',
      }),
    ]);
    expect(findings[0]?.file).toBeUndefined();
  });

  it('flags classic branch protection that allows force pushes', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rules/branches/main`]: [],
      [`${BASE}/branches/main`]: { protected: true },
      [`${BASE}/branches/main/protection`]: { allow_force_pushes: { enabled: true } },
    };
    const { findings } = await check(routes);
    expect(findings[0]?.message).toContain('its branch protection allows them');
  });

  it('accepts classic branch protection that blocks force pushes', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rules/branches/main`]: [],
      [`${BASE}/branches/main`]: { protected: true },
      [`${BASE}/branches/main/protection`]: { allow_force_pushes: { enabled: false } },
    };
    expect((await check(routes)).findings).toEqual([]);
  });

  it("says it couldn't check when classic protection needs admin access to read", async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rules/branches/main`]: [],
      [`${BASE}/branches/main`]: { protected: true },
      [`${BASE}/branches/main/protection`]: new Reply(403, {
        message: 'Resource not accessible by integration',
      }),
    };
    const { findings, warnings } = await check(routes);
    expect(findings).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^octo\/demo: Couldn't check whether branch protection on "main".*admin access/,
      ),
    ]);
  });

  it.each([
    ['x-ratelimit-remaining', '0'],
    ['retry-after', '60'],
  ])(
    'reports a rate limit (%s) on branch protection as a rate limit, not as missing admin access',
    async (header, value) => {
      const routes = {
        ...protectedRepo(),
        [`${BASE}/rules/branches/main`]: [],
        [`${BASE}/branches/main`]: { protected: true },
        [`${BASE}/branches/main/protection`]: new Reply(
          403,
          { message: 'API rate limit exceeded' },
          { [header]: value },
        ),
      };
      const { findings, warnings } = await check(routes);
      expect(findings).toEqual([]);
      expect(warnings).toEqual([
        'octo/demo: Couldn\'t check whether "main" can be force-pushed: GitHub API rate limit reached',
      ]);
    },
  );

  it('flags a branch whose protection turns out to be missing', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rules/branches/main`]: [{ type: 'pull_request' }],
      [`${BASE}/branches/main`]: { protected: true },
      [`${BASE}/branches/main/protection`]: new Reply(404, { message: 'Branch not protected' }),
    };
    expect(summary((await check(routes)).findings)).toEqual([
      'repo/force-push-allowed branch main',
    ]);
  });

  it.each([
    ['no tag ruleset', []],
    ['a ruleset only in evaluate mode', [{ id: 7, target: 'tag', enforcement: 'evaluate' }]],
  ])('flags tags that can be moved: %s', async (_, rulesets) => {
    const { findings } = await check({ ...protectedRepo(), [`${BASE}/rulesets`]: rulesets });
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'repo/force-push-allowed',
        subject: 'tags',
        message:
          'Tags can be moved or deleted: no active ruleset blocks updates to tag "v1.2.0", so it ' +
          'could be pointed at different code.',
      }),
    ]);
  });

  it.each([
    ['excludes the tag', { include: ['~ALL'], exclude: ['refs/tags/v1.*'] }, ['update']],
    ['covers other tags', { include: ['refs/tags/release-*'], exclude: [] }, ['update']],
    ['only restricts deletion', { include: ['~ALL'], exclude: [] }, ['deletion']],
    // A tag can still move forward to a new commit built on the one it points at.
    ['only blocks force pushes', { include: ['~ALL'], exclude: [] }, ['non_fast_forward']],
  ])('flags tags when the ruleset %s', async (_, refName, types) => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rulesets/7`]: {
        id: 7,
        target: 'tag',
        enforcement: 'active',
        conditions: { ref_name: refName },
        rules: types.map((type) => ({ type })),
      },
    };
    expect(summary((await check(routes)).findings)).toEqual(['repo/force-push-allowed tags']);
  });

  it('skips the tag check in a repository without tags', async () => {
    const { findings, calls } = await check({ ...protectedRepo(), [`${BASE}/tags`]: [] });
    expect(findings).toEqual([]);
    expect(calls.map((c) => c.url.pathname)).not.toContain(`${BASE}/rulesets`);
  });

  it('asks for up to 100 tags', async () => {
    const { calls } = await check(protectedRepo());
    const tags = calls.find((c) => c.url.pathname === `${BASE}/tags`);
    expect(tags?.url.searchParams.get('per_page')).toBe('100');
  });

  it.each([
    [
      'a release tag is protected, though the first tag listed is not',
      ['nightly', 'v1.2.0'],
      'refs/tags/v*',
      undefined,
    ],
    [
      'only the first tag listed is protected',
      ['nightly', 'v1.2.0'],
      'refs/tags/nightly',
      'v1.2.0',
    ],
    ['one release tag of several is not', ['v2.0.0', '1.9.0', 'v1.0.0'], 'refs/tags/v*', '1.9.0'],
    [
      'no tag looks like a release, so the first is checked',
      ['nightly', 'latest'],
      'refs/tags/latest',
      'nightly',
    ],
  ])('judges tag protection by the release tags: %s', async (_, names, include, unprotected) => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/tags`]: names.map((name) => ({ name })),
      [`${BASE}/rulesets/7`]: {
        id: 7,
        target: 'tag',
        enforcement: 'active',
        conditions: { ref_name: { include: [include], exclude: [] } },
        rules: [{ type: 'update' }],
      },
    };
    const { findings } = await check(routes);
    expect(findings.map((f) => f.message)).toEqual(
      unprotected === undefined
        ? []
        : [
            `Tags can be moved or deleted: no active ruleset blocks updates to tag "${unprotected}", ` +
              'so it could be pointed at different code.',
          ],
    );
  });

  it('fetches the active tag rulesets at the same time, and never the inactive ones', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rulesets`]: [
        { id: 5, enforcement: 'active' },
        { id: 6, enforcement: 'disabled' },
        { id: 7, enforcement: 'active' },
      ],
      [`${BASE}/rulesets/5`]: {
        id: 5,
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/tags/nightly'], exclude: [] } },
        rules: [{ type: 'update' }],
      },
    };
    let inFlight = 0;
    let mostAtOnce = 0;
    const { findings, calls } = await check(
      routes,
      undefined,
      false,
      (fetch) => async (input, init) => {
        if (!/\/rulesets\/\d+$/.test(new URL(String(input)).pathname)) return fetch(input, init);
        inFlight++;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return fetch(input, init);
      },
    );
    expect(findings).toEqual([]);
    expect(mostAtOnce).toBe(2);
    expect(calls.map((c) => c.url.pathname)).not.toContain(`${BASE}/rulesets/6`);
  });
});

describe('repo/force-push-detected', () => {
  const push = (actor: string | null, before: string, after: string, ref = 'refs/heads/main') => ({
    activity_type: 'force_push',
    ref,
    before: before.repeat(40),
    after: after.repeat(40),
    timestamp: '2026-10-01T12:00:00Z',
    actor: actor === null ? null : { login: actor },
  });

  it('reports each force push to the default branch in the last 90 days', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/activity`]: [
        push('mallory', 'a', 'b'),
        push(null, 'c', 'd'),
        push('bot', 'e', 'f', 'refs/heads/dev'),
      ],
    };
    const { findings, calls } = await check(routes);
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'repo/force-push-detected',
        severity: 'high',
        subject: 'branch main aaaaaaa..bbbbbbb',
        message:
          'mallory force-pushed the default branch "main" on 2026-10-01, replacing aaaaaaa with bbbbbbb.',
      }),
      expect.objectContaining({
        subject: 'branch main ccccccc..ddddddd',
        message: expect.stringMatching(/^Someone force-pushed/),
      }),
    ]);
    const activity = calls.find((c) => c.url.pathname === `${BASE}/activity`);
    expect(Object.fromEntries(activity?.url.searchParams ?? [])).toEqual({
      activity_type: 'force_push',
      ref: 'refs/heads/main',
      time_period: 'quarter',
      per_page: '100',
    });
  });

  it('warns when the activity log is not readable, and still checks the rest', async () => {
    const routes = {
      ...protectedRepo(),
      [`${BASE}/rules/branches/main`]: [],
      [`${BASE}/branches/main`]: { protected: false },
      [`${BASE}/activity`]: new Reply(403, { message: 'Resource not accessible by integration' }),
    };
    const { findings, warnings } = await check(routes);
    expect(summary(findings)).toEqual(['repo/force-push-allowed branch main']);
    expect(warnings).toEqual([
      'octo/demo: Couldn\'t check recent force pushes to "main": GitHub answered 403: Resource ' +
        'not accessible by integration. Check that the token can read this repository.',
    ]);
  });
});

describe('refPatternMatches', () => {
  it.each([
    ['~ALL', 'refs/tags/v1', true],
    ['refs/tags/v*', 'refs/tags/v1.2.0', true],
    ['refs/tags/v*', 'refs/tags/release/v1', false],
    ['refs/tags/**', 'refs/tags/release/v1', true],
    ['refs/tags/v?', 'refs/tags/v1', true],
    ['refs/tags/v1.0', 'refs/tags/v1x0', false],
    ['~DEFAULT_BRANCH', 'refs/tags/v1', false],
  ])('%s against %s is %s', (pattern, ref, expected) => {
    expect(refPatternMatches(pattern, ref)).toBe(expected);
  });
});
