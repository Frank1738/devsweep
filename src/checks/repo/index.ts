import { GitHubClient, segment } from '../../github/client.js';
import { findGitHubRepository } from '../../github/repository.js';
import type { Check } from '../../types.js';
import { type RepoContext, type Repository, reason } from './api.js';
import { checkForcePushAllowed, forcePushAllowed } from './force-push-allowed.js';
import { checkForcePushDetected, forcePushDetected } from './force-push-detected.js';

const SKIP_HINT = 'Pass --offline to skip these checks.';

/**
 * Settings of the repository on GitHub, read through the REST API. These are devsweep's only
 * network calls. Anything that stops them (no token, no GitHub remote, not enough access, GitHub
 * unreachable) becomes a "couldn't check" warning, never a finding.
 */
export const repoCheck: Check = {
  id: 'repo',
  description: 'Repository settings on GitHub',
  rules: [forcePushAllowed, forcePushDetected],
  network: true,

  async run(ctx) {
    if (ctx.offline) return [];

    const ref = await findGitHubRepository(ctx.root, ctx.env);
    if (!ref) {
      ctx.warn(
        "Couldn't check GitHub repository settings: no GitHub repository found. Set " +
          `GITHUB_REPOSITORY to owner/repo, or add an origin remote on github.com. ${SKIP_HINT}`,
      );
      return [];
    }
    const slug = `${ref.owner}/${ref.repo}`;

    // Read only from the environment: a --token flag would end up in shell history and process lists.
    const token = ctx.env.GITHUB_TOKEN || ctx.env.GH_TOKEN;
    if (!token) {
      ctx.warn(
        `Couldn't check GitHub repository settings for ${slug}: no token. Set GITHUB_TOKEN or ` +
          `GH_TOKEN (in a workflow, env: GITHUB_TOKEN: \${{ github.token }}). ${SKIP_HINT}`,
      );
      return [];
    }

    const api = new GitHubClient({ token, fetch: ctx.fetch, apiUrl: ctx.env.GITHUB_API_URL });
    const base = `/repos/${segment(ref.owner)}/${segment(ref.repo)}`;
    let repository: Repository;
    try {
      repository = await api.get<Repository>(base);
    } catch (error) {
      ctx.warn(`Couldn't check GitHub repository settings for ${slug}: ${reason(error)}`);
      return [];
    }

    const gh: RepoContext = {
      api,
      base,
      defaultBranch: repository.default_branch,
      warn: (message) => ctx.warn(`${slug}: ${message}`),
    };
    const [allowed, detected] = await Promise.all([
      checkForcePushAllowed(gh),
      checkForcePushDetected(gh),
    ]);
    return [...allowed, ...detected];
  },
};
