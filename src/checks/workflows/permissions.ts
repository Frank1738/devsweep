import { createFinding, type Finding, type Rule } from '../../types.js';
import type { Workflow } from './parse.js';

export const missingPermissions: Rule = {
  id: 'workflow/missing-permissions',
  title: 'Token permissions not limited',
  severity: 'medium',
  description:
    'Without a permissions block, jobs get the default GITHUB_TOKEN permissions from the ' +
    'repository or organization settings. On older repositories and many organizations that ' +
    'default is read and write for every scope, so any compromised step can push code, edit ' +
    'releases or approve pull requests.',
};

export const writeAllPermissions: Rule = {
  id: 'workflow/write-all-permissions',
  title: 'Token can write to everything',
  severity: 'high',
  description:
    'permissions: write-all gives the GITHUB_TOKEN write access to code, packages, releases, ' +
    'issues, pull requests and more. Any compromised step can use it.',
};

export const rules = [writeAllPermissions, missingPermissions] as const;

const LEAST_PRIVILEGE_FIX =
  'Set "permissions: contents: read" at the top of the workflow, and grant extra scopes only ' +
  'to the jobs that need them.';

export function analyze(workflow: Workflow): Finding[] {
  const findings: Finding[] = [];

  const declared = [
    ...(workflow.permissions
      ? [{ scope: 'Workflow', subject: 'whole workflow', permissions: workflow.permissions }]
      : []),
    ...workflow.jobs.flatMap((job) =>
      job.permissions
        ? [{ scope: `Job "${job.id}"`, subject: `job ${job.id}`, permissions: job.permissions }]
        : [],
    ),
  ];
  for (const { scope, subject, permissions } of declared) {
    if (permissions.value === 'write-all') {
      findings.push(
        createFinding(writeAllPermissions, {
          file: workflow.file,
          at: permissions,
          subject,
          message: `${scope} grants the GITHUB_TOKEN write access to every scope.`,
          remediation:
            'List only the scopes this workflow needs, e.g. "contents: read" plus specific writes.',
        }),
      );
    }
  }

  if (!workflow.permissions) {
    const unrestricted = workflow.jobs.filter((job) => !job.permissions);
    const [first] = unrestricted;
    if (first) {
      const names = unrestricted.map((job) => `"${job.id}"`).join(', ');
      const jobs =
        unrestricted.length === 1
          ? `job ${names} doesn't set its own, so it gets`
          : `jobs ${names} don't set their own, so they get`;
      findings.push(
        createFinding(missingPermissions, {
          file: workflow.file,
          at: first,
          subject: `${unrestricted.length === 1 ? 'job' : 'jobs'} ${unrestricted.map((job) => job.id).join(', ')}`,
          message:
            `No top-level permissions block, and ${jobs} the repository's default GITHUB_TOKEN ` +
            'permissions.',
          remediation: LEAST_PRIVILEGE_FIX,
        }),
      );
    }
  }

  return findings;
}
