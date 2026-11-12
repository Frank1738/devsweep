import { createFinding, type Finding, type Rule, type Severity } from '../../types.js';
import type { Step, Workflow } from './parse.js';
import { gitPushArgs, scriptLines, simpleCommands } from './shell.js';

export const forcePush: Rule = {
  id: 'workflow/force-push',
  title: 'Force push',
  severity: 'high',
  description:
    'A force push replaces history on the remote instead of adding to it. A workflow that ' +
    'force-pushes holds a token that can rewrite branches or move tags, and anyone who ' +
    'compromises the workflow, through a malicious dependency, action or injected script, can ' +
    'use it to hide what they changed. Severity depends on the target: high for main, master, ' +
    'tags and mirrors, medium for other branches, low for deploy branches such as gh-pages.',
  remediation:
    'Push without force where possible, so a diverged branch fails instead of being ' +
    'overwritten. Block force pushes on the default branch and release tags with a ruleset, ' +
    'and allow them only where a workflow needs them, such as a gh-pages deploy branch.',
};

export const rules = [forcePush] as const;

interface ForcePush {
  /** How the force was requested, e.g. `--force` or `force: true`. Never the full command. */
  how: string;
  /** Branches or tags being force-pushed. Empty means the checked-out branch. */
  targets: string[];
  allTags: boolean;
  mirror: boolean;
}

const LONG_FORCE = /^(--force(?:-with-lease)?)(?:=.*)?$/;
/** A short-option cluster containing -f, built only from git push's flags that take no value. */
const SHORT_FORCE = /^-[46dnquv]*f[46dnquv]*$/;
/** git push options whose value is a separate word. */
const PUSH_OPTIONS_WITH_VALUE = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
]);

const FORCE_INPUT = /^force(?:[-_](?:with[-_]lease|orphan))?$/i;
const PUSH_OPTIONS_INPUT = /^push[-_]options$/i;
const BRANCH_INPUT = /(?:^|[-_])branch$/i;
const TRUE = /^true$/i;

export function analyze(workflow: Workflow): Finding[] {
  return workflow.jobs.flatMap((job) =>
    job.steps.flatMap((step) => [
      ...(step.run
        ? scriptLines(step.run).flatMap((line) =>
            simpleCommands(line.text).flatMap((words) => {
              const args = gitPushArgs(words);
              const push = args && fromGitPush(args);
              return push ? [finding(workflow, job.id, push, line)] : [];
            }),
          )
        : []),
      ...fromActionInputs(step).map(({ push, at }) => finding(workflow, job.id, push, at)),
    ]),
  );
}

function fromGitPush(args: readonly string[]): ForcePush | undefined {
  let how: string | undefined;
  let allTags = false;
  let mirror = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const long = LONG_FORCE.exec(arg);
    if (arg === '--mirror') {
      mirror = true;
      how ??= arg;
    } else if (long) {
      how ??= long[1];
    } else if (SHORT_FORCE.test(arg)) {
      how ??= arg;
    } else if (arg === '--tags') {
      allTags = true;
    } else if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  // The first positional is the remote; the rest are refspecs. A leading "+" forces one refspec.
  const refspecs = positionals.slice(1);
  const plusRefspecs = refspecs.filter((refspec) => refspec.startsWith('+'));
  if (how === undefined && plusRefspecs.length === 0) return undefined;

  return {
    how: how ?? 'a "+" refspec',
    targets: (how === undefined ? plusRefspecs : refspecs).map(destination),
    allTags: allTags && how !== undefined,
    mirror,
  };
}

function fromActionInputs(step: Step): { push: ForcePush; at: { line: number; column: number } }[] {
  if (!step.uses) return [];
  const inputs = Object.entries(step.with);
  const force = inputs.find(
    ([key, input]) =>
      (FORCE_INPUT.test(key) && TRUE.test(input.value)) ||
      (PUSH_OPTIONS_INPUT.test(key) &&
        input.value.split(/\s+/).some((word) => LONG_FORCE.test(word) || SHORT_FORCE.test(word))),
  );
  if (!force) return [];

  const [key, input] = force;
  const targets = inputs
    .filter(([name]) => BRANCH_INPUT.test(name))
    .map(([, branch]) => branch.value);
  // Actions that deploy GitHub Pages publish to gh-pages unless told otherwise.
  if (targets.length === 0 && /pages/i.test(step.uses.value)) targets.push('gh-pages');

  return [
    {
      push: {
        how: `${key}: ${input.value}`,
        targets,
        allTags: inputs.some(([name, value]) => name === 'tags' && TRUE.test(value.value)),
        mirror: false,
      },
      at: input,
    },
  ];
}

/** The remote ref a refspec writes to: `+src:dst` → `dst`, `+main` → `main`. */
function destination(refspec: string): string {
  const ref = refspec.replace(/^\+/, '');
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function isTag(ref: string): boolean {
  return ref.startsWith('refs/tags/') || /^v\d+(?:\.\d+)*$/.test(ref);
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, '');
}

function isDefaultBranch(ref: string): boolean {
  return ['main', 'master'].includes(shortName(ref)) && !isTag(ref);
}

function isDeployBranch(ref: string): boolean {
  return shortName(ref) === 'gh-pages';
}

function severityOf(push: ForcePush): Severity {
  if (push.mirror || push.allTags || push.targets.some((t) => isTag(t) || isDefaultBranch(t))) {
    return 'high';
  }
  if (push.targets.length > 0 && push.targets.every(isDeployBranch)) return 'low';
  return 'medium';
}

/** Names the targets, quoting ref names when `quote` is set: `tag "v1"` or `tag v1`. */
function describeTargets(push: ForcePush, quote: boolean): string {
  if (push.mirror) return quote ? 'every branch and tag (a mirror)' : 'every branch and tag';
  const q = quote ? '"' : '';
  const targets = push.targets.map((t) => `${isTag(t) ? 'tag' : 'branch'} ${q}${shortName(t)}${q}`);
  if (push.allTags) targets.unshift('all tags');
  if (targets.length > 0) return targets.join(', ');
  return quote ? 'the checked-out branch' : 'checked-out branch';
}

function finding(
  workflow: Workflow,
  jobId: string,
  push: ForcePush,
  at: { line: number; column?: number | undefined },
): Finding {
  const severity = severityOf(push);
  const action = `Job "${jobId}" force-pushes (${push.how}) to ${describeTargets(push, true)}`;
  return createFinding(forcePush, {
    file: workflow.file,
    at,
    severity,
    subject: describeTargets(push, false),
    ...(severity === 'low'
      ? {
          message: `${action}. That's normal for publishing a site, but the job's token can rewrite that branch.`,
          remediation:
            'No change needed if this is intended. Keep force pushes blocked on the default ' +
            'branch and release tags, so a compromised job can only rewrite the deploy branch.',
        }
      : {
          message: `${action}, which rewrites history on the remote instead of adding to it.`,
          remediation:
            'Push without force where possible, so a diverged branch fails instead of being ' +
            'overwritten. Block force pushes on the default branch and release tags with a ' +
            'ruleset, and allow them only where this workflow needs them.',
        }),
  });
}
