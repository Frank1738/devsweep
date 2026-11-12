/** A canned non-200 answer. Plain values in a route table are 200 responses. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
    readonly headers: Record<string, string> = {},
  ) {}
}

export interface Call {
  url: URL;
  headers: Headers;
}

/**
 * A fake GitHub API: answers each request from `routes` by URL path (the query is ignored) and
 * records every call. Unknown paths get a 404, as GitHub would.
 */
export function fakeGitHub(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url.pathname];
    const reply =
      route === undefined
        ? new Reply(404, { message: 'Not Found' })
        : route instanceof Reply
          ? route
          : new Reply(200, route);
    if (reply.status === 0) throw reply.body;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  return { fetch, calls };
}

export const BASE = '/repos/octo/demo';

/** A repository with everything protected: rulesets on main and on v* tags, no force pushes. */
export function protectedRepo(): Record<string, unknown> {
  return {
    [BASE]: { default_branch: 'main' },
    [`${BASE}/rules/branches/main`]: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    [`${BASE}/tags`]: [{ name: 'v1.2.0' }],
    [`${BASE}/rulesets`]: [{ id: 7, target: 'tag', enforcement: 'active' }],
    [`${BASE}/rulesets/7`]: {
      id: 7,
      target: 'tag',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      rules: [{ type: 'update' }, { type: 'deletion' }],
    },
    [`${BASE}/activity`]: [],
  };
}
