import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { compareText } from '../../compare.js';
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

    // readdir's order depends on the file system, so sort by name to keep output the same.
    const names = entries
      .filter((entry) => entry.isFile() && WORKFLOW_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareText);
    // Read and parse every file at the same time.
    const parsing = names.map((name) => {
      const file = `${WORKFLOWS_DIR}/${name}`;
      return {
        file,
        workflow: readFile(path.join(dir, name), 'utf8').then((source) =>
          parseWorkflow(source, file),
        ),
      };
    });
    // Wait for all of them first. Otherwise a file that fails while the loop below still waits
    // for an earlier one would be an unhandled rejection, which stops Node.
    await Promise.allSettled(parsing.map((p) => p.workflow));

    // Report in name order. An unexpected error rejects for the first such file by name, after
    // the files before it are reported, as if they had been read one at a time.
    const findings: Finding[] = [];
    for (const { file, workflow: parsed } of parsing) {
      let workflow: Workflow | undefined;
      try {
        workflow = await parsed;
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

function analyze(workflow: Workflow): Finding[] {
  return analyzers.flatMap((a) => a.analyze(workflow));
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
