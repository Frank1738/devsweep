import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Scalar,
  type YAMLMap,
} from 'yaml';
import type { Position } from '../../types.js';

export interface Located<T> extends Position {
  value: T;
}

export type Permissions = string | Record<string, string>;

/**
 * A `run:` script. When `literal` is true (`run: |`), line `i` of the value sits on line
 * `line + 1 + i` of the workflow file. Other scalar styles fold lines, so only the start is known.
 */
export interface Script extends Located<string> {
  literal: boolean;
}

export interface Step extends Position {
  uses?: Located<string>;
  run?: Script;
  /** Scalar `with:` inputs only. */
  with: Record<string, Located<string>>;
}

export interface Job extends Position {
  id: string;
  /** Set when the job calls a reusable workflow. */
  uses?: Located<string>;
  permissions?: Located<Permissions>;
  steps: Step[];
}

export interface Workflow {
  /** Path relative to the scan root, with forward slashes. */
  file: string;
  /** Event names from `on:`, located at the event name. */
  triggers: Located<string>[];
  /** Located at the `permissions` key. */
  permissions?: Located<Permissions>;
  jobs: Job[];
}

export class WorkflowParseError extends Error {}

interface Entry {
  key: string;
  keyNode: Scalar;
  value: unknown;
}

/**
 * Parses a GitHub Actions workflow into the parts devsweep's rules need, keeping line numbers.
 * Returns undefined when the YAML is valid but isn't shaped like a workflow.
 *
 * YAML 1.2 is used on purpose: under YAML 1.1 the `on:` key would parse as boolean `true`.
 */
export function parseWorkflow(source: string, file: string): Workflow | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });
  const [firstError] = doc.errors;
  if (firstError) throw new WorkflowParseError(firstError.message);

  const reader = new Reader(doc, lineCounter);
  const root = reader.deref(doc.contents);
  if (!isMap(root)) return undefined;

  const permissions = reader.permissions(root);
  return {
    file,
    triggers: reader.triggers(root),
    ...(permissions && { permissions }),
    jobs: reader.jobs(root),
  };
}

class Reader {
  constructor(
    private readonly doc: Document,
    private readonly lineCounter: LineCounter,
  ) {}

  triggers(root: YAMLMap): Located<string>[] {
    const on = this.field(root, 'on')?.value;
    if (isMap(on)) return this.entries(on).map((e) => ({ value: e.key, ...this.at(e.keyNode) }));
    if (isSeq(on)) return on.items.flatMap((item) => this.string(this.deref(item)) ?? []);
    const single = this.string(on);
    return single ? [single] : [];
  }

  jobs(root: YAMLMap): Job[] {
    const jobs = this.field(root, 'jobs')?.value;
    if (!isMap(jobs)) return [];
    return this.entries(jobs).flatMap(({ key, keyNode, value }) => {
      if (!isMap(value)) return [];
      const uses = this.string(this.field(value, 'uses')?.value);
      const permissions = this.permissions(value);
      return [
        {
          id: key,
          ...this.at(keyNode),
          ...(uses && { uses }),
          ...(permissions && { permissions }),
          steps: this.steps(value),
        },
      ];
    });
  }

  permissions(map: YAMLMap): Located<Permissions> | undefined {
    const field = this.field(map, 'permissions');
    if (!field) return undefined;
    const { value } = field;
    const permissions: Permissions = isMap(value)
      ? Object.fromEntries(
          this.entries(value).map((e) => [e.key, this.string(this.deref(e.value))?.value ?? '']),
        )
      : (this.string(value)?.value ?? '');
    return { value: permissions, ...this.at(field.keyNode) };
  }

  private steps(job: YAMLMap): Step[] {
    const steps = this.field(job, 'steps')?.value;
    if (!isSeq(steps)) return [];
    return steps.items.flatMap((item) => {
      const step = this.deref(item);
      if (!isMap(step)) return [];
      const uses = this.string(this.field(step, 'uses')?.value);
      const run = this.script(this.field(step, 'run')?.value);
      const withInputs = this.field(step, 'with')?.value;
      return [
        {
          ...this.at(step),
          ...(uses && { uses }),
          ...(run && { run }),
          with: isMap(withInputs)
            ? Object.fromEntries(
                this.entries(withInputs).flatMap((e) => {
                  const input = this.string(e.value);
                  return input ? [[e.key, input]] : [];
                }),
              )
            : {},
        },
      ];
    });
  }

  private entries(map: YAMLMap): Entry[] {
    return map.items.flatMap((pair) => {
      const keyNode = this.deref(pair.key);
      if (!isScalar(keyNode)) return [];
      return [{ key: String(keyNode.value), keyNode, value: this.deref(pair.value) }];
    });
  }

  private field(map: YAMLMap, key: string): Entry | undefined {
    return this.entries(map).find((e) => e.key === key);
  }

  private script(node: unknown): Script | undefined {
    const script = this.string(node);
    if (!script) return undefined;
    return { ...script, literal: isScalar(node) && node.type === 'BLOCK_LITERAL' };
  }

  private string(node: unknown): Located<string> | undefined {
    if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
    return { value: String(node.value), ...this.at(node) };
  }

  deref(node: unknown): unknown {
    return isAlias(node) ? node.resolve(this.doc) : node;
  }

  private at(node: { range?: readonly number[] | null | undefined }): Position {
    const { line, col } = this.lineCounter.linePos(node.range?.[0] ?? 0);
    return { line, column: col };
  }
}
