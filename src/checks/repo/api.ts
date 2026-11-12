import { errorMessage } from '../../errors.js';
import type { GitHubClient } from '../../github/client.js';
import { GitHubApiError } from '../../github/client.js';

/** What the repository checks share: one client, one repository, and somewhere to warn. */
export interface RepoContext {
  api: GitHubClient;
  /** `/repos/{owner}/{repo}` */
  base: string;
  defaultBranch: string;
  warn(message: string): void;
}

// The few response fields devsweep reads.

export interface Repository {
  default_branch: string;
}

export interface BranchRule {
  type: string;
}

export interface Branch {
  protected: boolean;
}

export interface BranchProtection {
  allow_force_pushes?: { enabled: boolean } | null;
}

export interface Tag {
  name: string;
}

export interface RulesetSummary {
  id: number;
  enforcement: string;
}

export interface Ruleset extends RulesetSummary {
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  rules?: { type: string }[];
}

export interface Activity {
  before: string;
  after: string;
  ref: string;
  timestamp: string;
  activity_type: string;
  actor: { login: string } | null;
}

/** Why a request failed, in words that suggest what to do about it. */
export function reason(error: unknown): string {
  if (!(error instanceof GitHubApiError)) return errorMessage(error);
  if (!error.rateLimited && [401, 403, 404].includes(error.status)) {
    return `${error.message}. Check that the token can read this repository.`;
  }
  return error.message;
}

/** Matches a ruleset's ref_name pattern (fnmatch-style, plus ~ALL) against a full ref name. */
export function refPatternMatches(pattern: string, ref: string): boolean {
  if (pattern === '~ALL') return true;
  if (pattern.startsWith('~')) return false;
  const source = pattern
    .split(/(\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`).test(ref);
}
