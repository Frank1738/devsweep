import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, type Workflow } from '../src/checks/workflows/parse.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

/** Strips the common leading indentation so YAML can be written indented inside tests. */
export function dedent(text: string): string {
  const lines = text
    .replace(/^\n/, '')
    .replace(/\n\s*$/, '\n')
    .split('\n');
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^ */.exec(line)?.[0].length ?? 0);
  const common = Math.min(...indents);
  return lines.map((line) => line.slice(common)).join('\n');
}

export function workflow(yaml: string): Workflow {
  const parsed = parseWorkflow(dedent(yaml), '.github/workflows/test.yml');
  if (!parsed) throw new Error('test YAML is not a workflow');
  return parsed;
}
