import { createFinding, type Finding, type Rule } from '../../types.js';
import { type Activity, type RepoContext, reason } from './api.js';

export const forcePushDetected: Rule = {
  id: 'repo/force-push-detected',
  title: 'Recent force push',
  severity: 'high',
  description:
    'Someone force-pushed the default branch in the last 90 days, replacing part of its ' +
    'history. That can be routine cleanup, but it is also how a stolen token hides what it ' +
    'changed. GitHub keeps a record of force pushes for branches only, so moved tags cannot be ' +
    'detected this way.',
  remediation:
    "Open the repository's Activity view on GitHub, compare the commits before and after the " +
    'push, and confirm who made it and why. Then accept the finding in devsweep.config.json ' +
    'with that reason, and block future force pushes with a ruleset.',
};

/** How far back to look. The activity API offers day, week, month, quarter or year. */
const PERIOD = 'quarter';

export async function checkForcePushDetected(gh: RepoContext): Promise<Finding[]> {
  const branch = gh.defaultBranch;
  const ref = `refs/heads/${branch}`;
  try {
    const activity = await gh.api.get<Activity[]>(`${gh.base}/activity`, {
      activity_type: 'force_push',
      ref,
      time_period: PERIOD,
      per_page: 100,
    });
    return activity
      .filter((event) => event.activity_type === 'force_push' && event.ref === ref)
      .map((event) => {
        const before = event.before.slice(0, 7);
        const after = event.after.slice(0, 7);
        const who = event.actor?.login ?? 'Someone';
        return createFinding(forcePushDetected, {
          // One finding per push, so accepting a reviewed push doesn't hide the next one.
          subject: `branch ${branch} ${before}..${after}`,
          message:
            `${who} force-pushed the default branch "${branch}" on ${event.timestamp.slice(0, 10)}, ` +
            `replacing ${before} with ${after}.`,
        });
      });
  } catch (error) {
    gh.warn(`Couldn't check recent force pushes to "${branch}": ${reason(error)}`);
    return [];
  }
}
