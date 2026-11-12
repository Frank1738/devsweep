import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Check, Finding } from '../../types.js';
import * as forcePush from './force-push.js';
import { parseWorkflow, type Workflow, WorkflowParseError } from './parse.js';
import * as permissions from './permissions.js';
import * as pullRequestTarget from './pull-request-target.js';
import * as unpinnedActions from './unpinned-actions.js';

const analyzers = [pullRequestTarget, unpinnedActions, permissions, forcePush];

/** GitHub only reads workflows from this directory, and not from its subdirectories. */
const WORKFLOWS_DIR = '.github/workflows';
const WORKFLOW_FILE = /\.ya?ml$/i;

export const workflowsCheck: Check = {
  id: 'workflows',
  description: 'Risky GitHub Actions workflow settings',
  rules: analyzers.flatMap((a) => a.rules),

  async run(ctx) {
    const dir = path.join(ctx.root, WORKFLOWS_DIR);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const findings: Finding[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !WORKFLOW_FILE.test(entry.name)) continue;
      const file = `${WORKFLOWS_DIR}/${entry.name}`;
      let workflow: Workflow | undefined;
      try {
        workflow = parseWorkflow(await readFile(path.join(dir, entry.name), 'utf8'), file);
      } catch (error) {
        if (!(error instanceof WorkflowParseError)) throw error;
        ctx.warn(`Skipped invalid YAML: ${error.message}`, file);
        continue;
      }
      if (workflow) findings.push(...analyze(workflow));
    }
    return findings;
  },
};

export function analyze(workflow: Workflow): Finding[] {
  return analyzers.flatMap((a) => a.analyze(workflow));
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
