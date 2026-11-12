import { GitHubApiError, segment } from '../../github/client.js';
import { createFinding, type Finding, type Rule } from '../../types.js';
import {
  type Branch,
  type BranchProtection,
  type BranchRule,
  type RepoContext,
  type Ruleset,
  type RulesetSummary,
  reason,
  refPatternMatches,
  type Tag,
} from './api.js';

export const forcePushAllowed: Rule = {
  id: 'repo/force-push-allowed',
  title: 'Force pushes allowed',
  severity: 'high',
  description:
    'Without a ruleset or branch protection that blocks it, anyone with write access, or a ' +
    'stolen token with write access, can force-push the default branch or move a release tag. ' +
    'That rewrites history and can point a trusted tag at malicious code, which is how the ' +
    'tj-actions/changed-files attack in March 2025 reached thousands of repositories.',
  remediation:
    'In Settings → Rules → Rulesets, add a branch ruleset for the default branch with "Block ' +
    'force pushes" and "Restrict deletions", and a tag ruleset for release tags (e.g. ' +
    'refs/tags/v*) with "Restrict updates" and "Restrict deletions".',
};

/** Rule types that stop the default branch from being force-pushed. */
const BLOCKS_FORCE_PUSH = new Set(['non_fast_forward', 'update']);

/**
 * Rule types that stop a tag from being moved. "Block force pushes" (non_fast_forward) isn't
 * enough: it still lets a tag move forward to a new commit built on top of the one it points at.
 */
const BLOCKS_TAG_MOVE = new Set(['update']);

/** Why the default branch can be force-pushed when nothing protects it. */
const UNPROTECTED = 'no ruleset blocks force pushes, and it has no branch protection';

export async function checkForcePushAllowed(gh: RepoContext): Promise<Finding[]> {
  const [branch, tags] = await Promise.all([checkDefaultBranch(gh), checkTags(gh)]);
  return [...branch, ...tags];
}

/**
 * Rulesets can be read with any token, so they come first. Classic branch protection needs admin
 * access to read, so without it the answer is "couldn't check" rather than a guess.
 */
async function checkDefaultBranch(gh: RepoContext): Promise<Finding[]> {
  const name = gh.defaultBranch;
  const route = `${gh.base}/branches/${segment(name)}`;
  const allowed = (why: string) => [
    createFinding(forcePushAllowed, {
      subject: `branch ${name}`,
      message: `The default branch "${name}" can be force-pushed: ${why}.`,
      remediation:
        `Add a branch ruleset for "${name}" with "Block force pushes" and "Restrict deletions", ` +
        'in Settings → Rules → Rulesets.',
    }),
  ];

  try {
    const rules = await gh.api.get<BranchRule[]>(`${gh.base}/rules/branches/${segment(name)}`, {
      per_page: 100,
    });
    if (rules.some((rule) => BLOCKS_FORCE_PUSH.has(rule.type))) return [];

    const branch = await gh.api.get<Branch>(route);
    if (!branch.protected) return allowed(UNPROTECTED);

    let protection: BranchProtection;
    try {
      protection = await gh.api.get<BranchProtection>(`${route}/protection`);
    } catch (error) {
      // Rate limits fall through to the general warning: they say nothing about access.
      if (
        !(error instanceof GitHubApiError) ||
        error.rateLimited ||
        ![401, 403, 404].includes(error.status)
      )
        throw error;
      if (/branch not protected/i.test(error.message)) return allowed(UNPROTECTED);
      gh.warn(
        `Couldn't check whether branch protection on "${name}" allows force pushes: reading it ` +
          'needs admin access ("Administration: read" for a fine-grained token). A ruleset that ' +
          'blocks force pushes can be read with any token.',
      );
      return [];
    }
    return protection.allow_force_pushes?.enabled
      ? allowed('its branch protection allows them')
      : [];
  } catch (error) {
    gh.warn(`Couldn't check whether "${name}" can be force-pushed: ${reason(error)}`);
    return [];
  }
}

/** A release version, with or without a leading "v": 1.2.3, v1.2.3, v1.2.3-rc.1. */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/;

/**
 * Only repositories with tags are checked. Of the latest 100 tags, the release tags are the ones
 * that matter; when none look like releases, the first tag stands in for them.
 */
async function checkTags(gh: RepoContext): Promise<Finding[]> {
  try {
    const tags = await gh.api.get<Tag[]>(`${gh.base}/tags`, { per_page: 100 });
    if (tags.length === 0) return [];
    const releases = tags.filter((tag) => RELEASE_TAG.test(tag.name));
    const checked = releases.length > 0 ? releases : tags.slice(0, 1);

    const summaries = await gh.api.get<RulesetSummary[]>(`${gh.base}/rulesets`, {
      targets: 'tag',
      includes_parents: true,
      per_page: 100,
    });
    const rulesets = await Promise.all(
      summaries
        .filter((summary) => summary.enforcement === 'active')
        .map((summary) =>
          gh.api.get<Ruleset>(`${gh.base}/rulesets/${summary.id}`, { includes_parents: true }),
        ),
    );
    const unprotected = checked.find(
      (tag) => !rulesets.some((ruleset) => protectsTag(ruleset, `refs/tags/${tag.name}`)),
    );
    if (!unprotected) return [];

    return [
      createFinding(forcePushAllowed, {
        subject: 'tags',
        message:
          'Tags can be moved or deleted: no active ruleset blocks updates to tag ' +
          `"${unprotected.name}", so it could be pointed at different code.`,
        remediation:
          'Add a tag ruleset that targets your release tags (e.g. refs/tags/v*) with "Restrict ' +
          'updates" and "Restrict deletions", in Settings → Rules → Rulesets.',
      }),
    ];
  } catch (error) {
    gh.warn(`Couldn't check whether tags can be moved: ${reason(error)}`);
    return [];
  }
}

/** Whether `ruleset` covers the tag `ref` and stops it moving. Only active rulesets are passed in. */
function protectsTag(ruleset: Ruleset, ref: string): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const covers =
    include.some((pattern) => refPatternMatches(pattern, ref)) &&
    !exclude.some((pattern) => refPatternMatches(pattern, ref));
  return covers && (ruleset.rules ?? []).some((rule) => BLOCKS_TAG_MOVE.has(rule.type));
}
