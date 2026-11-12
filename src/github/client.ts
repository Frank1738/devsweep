import { errorMessage } from '../errors.js';
import { VERSION } from '../version.js';

export interface GitHubClientOptions {
  /** Sent only in the Authorization header. Never logged or put in an error message. */
  token: string;
  fetch: typeof fetch;
  /** GITHUB_API_URL in Actions; api.github.com otherwise. */
  apiUrl?: string | undefined;
  timeoutMs?: number;
}

/** A request that failed. `status` is 0 when there was no response at all. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;

/** A small read-only REST client on Node's built-in fetch. */
export class GitHubClient {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GETs `route` (e.g. `/repos/o/r`) and returns the parsed JSON. Throws GitHubApiError. */
  async get<T>(route: string, query: Record<string, string | number | boolean> = {}): Promise<T> {
    const url = new URL(`${this.apiUrl}${route}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'User-Agent': `devsweep/${VERSION}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new GitHubApiError(
        0,
        timedOut
          ? `GitHub didn't answer within ${this.timeoutMs / 1000} seconds`
          : `couldn't reach GitHub (${errorMessage(error)})`,
      );
    }

    if (!response.ok) {
      // A primary rate limit sets x-ratelimit-remaining to 0. A secondary one, for too many
      // requests at once, sends retry-after instead.
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')));
      if (rateLimited)
        throw new GitHubApiError(response.status, 'GitHub API rate limit reached', true);
      throw new GitHubApiError(response.status, await describeFailure(response));
    }
    return (await response.json()) as T;
  }
}

async function describeFailure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
  const message = typeof body?.message === 'string' ? body.message : response.statusText;
  return `GitHub answered ${response.status}${message ? `: ${message}` : ''}`;
}

/** Encodes a route segment such as a branch name, keeping the slashes GitHub expects. */
export function segment(value: string): string {
  return encodeURIComponent(value).replaceAll('%2F', '/');
}
