import { createFinding, type Finding, type Rule } from '../../types.js';
import type { Workflow } from './parse.js';
import { scriptLines } from './shell.js';

export const untrustedCheckout: Rule = {
  id: 'workflow/untrusted-checkout',
  title: 'Runs pull request code with secrets',
  severity: 'critical',
  description:
    'Workflows triggered by pull_request_target run with repository secrets and a GITHUB_TOKEN ' +
    'that can write. Checking out the pull request head lets anyone who opens a PR from a fork ' +
    'run their own code with those secrets (a "pwn request").',
  remediation:
    'Switch to the pull_request trigger, or split the work: build untrusted code in a ' +
    'pull_request workflow with no secrets, then act on its results in a separate ' +
    'workflow_run workflow.',
};

export const pullRequestTarget: Rule = {
  id: 'workflow/pull-request-target',
  title: 'Uses the pull_request_target trigger',
  severity: 'medium',
  description:
    'pull_request_target runs in the context of the base repository, with secrets and a ' +
    'GITHUB_TOKEN that can write, even for pull requests from forks. It is safe only if the ' +
    'workflow never checks out, builds or runs code from the pull request.',
  remediation:
    'Use the pull_request trigger unless the workflow needs secrets or write access. If it ' +
    'does, never check out or run code from the pull request.',
};

export const rules = [untrustedCheckout, pullRequestTarget] as const;

/** Expressions and refs that point at the pull request's own code rather than the base branch. */
const PR_HEAD_REF =
  /github\.event\.pull_request\.head\.(?:sha|ref)\b|github\.head_ref\b|refs\/pull\//;
const GIT_FETCH_OR_CHECKOUT = /\bgit\s+(?:fetch|checkout|switch|pull)\b/;
const GH_PR_CHECKOUT = /\bgh\s+pr\s+checkout\b/;

export function analyze(workflow: Workflow): Finding[] {
  const trigger = workflow.triggers.find((t) => t.value === 'pull_request_target');
  if (!trigger) return [];

  const checkouts = workflow.jobs.flatMap((job) =>
    job.steps.flatMap((step) => {
      const ref = step.with.ref;
      if (step.uses && isCheckoutAction(step.uses.value) && ref && PR_HEAD_REF.test(ref.value)) {
        return [checkoutFinding(workflow, job.id, ref, `checks out ref "${ref.value}"`)];
      }
      const fetch = step.run && scriptLines(step.run).find((line) => fetchesPullRequest(line.text));
      if (fetch) {
        return [checkoutFinding(workflow, job.id, fetch, 'fetches the pull request in a run step')];
      }
      return [];
    }),
  );
  if (checkouts.length > 0) return checkouts;

  return [
    createFinding(pullRequestTarget, {
      file: workflow.file,
      at: trigger,
      message:
        'Workflow is triggered by pull_request_target, so it runs with secrets and a write token ' +
        'for pull requests from forks.',
      remediation: pullRequestTarget.remediation,
    }),
  ];
}

function isCheckoutAction(uses: string): boolean {
  return uses.toLowerCase().startsWith('actions/checkout@');
}

function fetchesPullRequest(line: string): boolean {
  return GH_PR_CHECKOUT.test(line) || (GIT_FETCH_OR_CHECKOUT.test(line) && PR_HEAD_REF.test(line));
}

function checkoutFinding(
  workflow: Workflow,
  jobId: string,
  location: { line: number; column?: number | undefined },
  what: string,
): Finding {
  return createFinding(untrustedCheckout, {
    file: workflow.file,
    at: location,
    subject: `job ${jobId}`,
    message:
      `Job "${jobId}" runs on pull_request_target and ${what}, so code from any fork can run ` +
      "with this repository's secrets and write token.",
    remediation: untrustedCheckout.remediation,
  });
}
