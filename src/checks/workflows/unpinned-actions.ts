import { createFinding, type Finding, type Rule } from '../../types.js';
import type { Located, Workflow } from './parse.js';

export const unpinnedAction: Rule = {
  id: 'workflow/unpinned-action',
  title: 'Unpinned action',
  severity: 'high',
  description:
    'Tags and branches can be moved to point at different code at any time. If the owner of a ' +
    'third-party action is compromised, every workflow that references it by tag runs the ' +
    "attacker's code with that workflow's secrets. Only a full commit SHA is immutable.",
  remediation:
    'Pin third-party actions and reusable workflows to a full 40-character commit SHA, with ' +
    'the version in a comment (uses: owner/action@<sha> # v1.2.3), and pin container images ' +
    'by digest (docker://image@sha256:<digest>). Dependabot and Renovate can keep the pins up ' +
    'to date.',
};

export const rules = [unpinnedAction] as const;

/**
 * Actions owned by GitHub itself. Not flagged: they carry far less risk than third-party
 * actions, and flagging them would bury real findings in noise.
 */
const GITHUB_OWNED = new Set(['actions', 'github']);
const FULL_SHA = /^[0-9a-f]{40}$/i;

export function analyze(workflow: Workflow): Finding[] {
  const references = workflow.jobs.flatMap((job) => [
    ...(job.uses ? [job.uses] : []),
    ...job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
  ]);
  return references.flatMap((uses) => {
    const problem = describeProblem(uses.value);
    return problem ? [finding(workflow, uses, problem)] : [];
  });
}

interface Problem {
  message: string;
  remediation: string;
}

function describeProblem(uses: string): Problem | undefined {
  if (uses.startsWith('./')) return undefined;

  if (uses.startsWith('docker://')) {
    if (uses.includes('@sha256:')) return undefined;
    return {
      message: `Container image "${uses}" is not pinned to a digest.`,
      remediation: 'Pin the image by digest, e.g. docker://image@sha256:<digest>.',
    };
  }

  const at = uses.lastIndexOf('@');
  const name = at === -1 ? uses : uses.slice(0, at);
  const ref = at === -1 ? '' : uses.slice(at + 1);
  const owner = name.split('/')[0]?.toLowerCase() ?? '';
  if (GITHUB_OWNED.has(owner) || FULL_SHA.test(ref)) return undefined;

  return {
    message: ref
      ? `Third-party action "${name}" is pinned to "${ref}", a tag or branch its owner can move.`
      : `Third-party action "${name}" has no version, so it can change at any time.`,
    remediation: `Pin it to a full commit SHA: uses: ${name}@<40-character-sha>${ref ? ` # ${ref}` : ''}`,
  };
}

function finding(workflow: Workflow, uses: Located<string>, problem: Problem): Finding {
  return createFinding(unpinnedAction, {
    file: workflow.file,
    at: uses,
    subject: uses.value,
    message: problem.message,
    remediation: problem.remediation,
  });
}
