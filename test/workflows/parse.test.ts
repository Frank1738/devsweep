import { describe, expect, it } from 'vitest';
import { parseWorkflow, WorkflowParseError } from '../../src/checks/workflows/parse.js';
import { dedent, workflow } from '../helpers.js';

describe('parseWorkflow', () => {
  it('reads a single trigger and keeps "on" as a string key', () => {
    const wf = workflow(`
      on: push
      jobs: {}
    `);
    expect(wf.triggers).toEqual([{ value: 'push', line: 1, column: 5 }]);
  });

  it('reads triggers written as a list', () => {
    const wf = workflow(`
      on: [push, pull_request_target]
    `);
    expect(wf.triggers.map((t) => t.value)).toEqual(['push', 'pull_request_target']);
    expect(wf.triggers[1]).toMatchObject({ line: 1, column: 12 });
  });

  it('reads triggers written as a map, located at the event name', () => {
    const wf = workflow(`
      on:
        push:
          branches: [main]
        pull_request_target:
          types: [opened]
    `);
    expect(wf.triggers).toEqual([
      { value: 'push', line: 2, column: 3 },
      { value: 'pull_request_target', line: 4, column: 3 },
    ]);
  });

  it('reads jobs, steps and their inputs with positions', () => {
    const wf = workflow(`
      on: push
      jobs:
        build:
          runs-on: ubuntu-latest
          steps:
            - uses: actions/checkout@v4
              with:
                ref: main
                fetch-depth: 0
            - run: npm test
        shared:
          uses: example-org/workflows/.github/workflows/build.yml@v1
    `);
    const [build, shared] = wf.jobs;
    expect(build).toMatchObject({ id: 'build', line: 3, column: 3 });
    expect(build?.steps).toEqual([
      {
        line: 6,
        column: 9,
        uses: { value: 'actions/checkout@v4', line: 6, column: 15 },
        with: {
          ref: { value: 'main', line: 8, column: 16 },
          'fetch-depth': { value: '0', line: 9, column: 24 },
        },
      },
      {
        line: 10,
        column: 9,
        run: { value: 'npm test', line: 10, column: 14, literal: false },
        with: {},
      },
    ]);
    expect(shared?.uses).toMatchObject({
      value: 'example-org/workflows/.github/workflows/build.yml@v1',
      line: 12,
    });
  });

  it('reads permissions as a scalar or a map, located at the key', () => {
    const wf = workflow(`
      on: push
      permissions: read-all
      jobs:
        deploy:
          permissions:
            contents: write
            id-token: write
    `);
    expect(wf.permissions).toEqual({ value: 'read-all', line: 2, column: 1 });
    expect(wf.jobs[0]?.permissions).toEqual({
      value: { contents: 'write', 'id-token': 'write' },
      line: 5,
      column: 5,
    });
  });

  it('marks literal block scripts, located at the block header', () => {
    const wf = workflow(`
      on: push
      jobs:
        build:
          steps:
            - run: |
                npm ci
                npm test
            - run: >
                folded
    `);
    expect(wf.jobs[0]?.steps.map((step) => step.run)).toEqual([
      { value: 'npm ci\nnpm test\n', line: 5, column: 14, literal: true },
      { value: 'folded\n', line: 8, column: 14, literal: false },
    ]);
  });

  it('resolves YAML aliases', () => {
    const wf = workflow(`
      on: push
      jobs:
        a:
          steps:
            - &checkout
              uses: example-org/checkout@v1
        b:
          steps:
            - *checkout
    `);
    expect(wf.jobs[1]?.steps[0]?.uses?.value).toBe('example-org/checkout@v1');
  });

  it('uses the first of two keys that read the same', () => {
    // YAML only rejects a key written twice. An alias to a key is a different node, so it's allowed.
    const wf = workflow(`
      on: push
      jobs:
        a:
          steps:
            - &uses uses: example-org/first@v1
              *uses : example-org/second@v1
    `);
    expect(wf.jobs[0]?.steps[0]?.uses?.value).toBe('example-org/first@v1');
  });

  it('throws WorkflowParseError on invalid YAML', () => {
    expect(() => parseWorkflow('jobs: [unclosed', 'x.yml')).toThrow(WorkflowParseError);
  });

  it('returns undefined for YAML that is not a mapping', () => {
    expect(parseWorkflow('', 'x.yml')).toBeUndefined();
    expect(parseWorkflow(dedent('- a\n- b\n'), 'x.yml')).toBeUndefined();
  });
});
