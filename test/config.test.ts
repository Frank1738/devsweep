import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rules } from '../src/checks/index.js';
import {
  applyConfig,
  CONFIG_FILE,
  ConfigError,
  EMPTY_CONFIG,
  loadConfig,
  parseConfig,
} from '../src/config.js';
import { scan } from '../src/scanner.js';
import type { Finding } from '../src/types.js';
import { fixture } from './helpers.js';

const RULES = rules.map((rule) => rule.id);
const parse = (value: unknown) =>
  parseConfig(typeof value === 'string' ? value : JSON.stringify(value), RULES);

const unpinned: Finding = {
  ruleId: 'workflow/unpinned-action',
  severity: 'high',
  message: 'Unpinned.',
  subject: 'example-org/deploy@v2',
  file: '.github/workflows/ci.yml',
  line: 7,
};

const trigger: Finding = {
  ruleId: 'workflow/pull-request-target',
  severity: 'medium',
  message: 'pull_request_target.',
  file: '.github/workflows/label.yml',
  line: 3,
};

describe('parseConfig', () => {
  it('reads acceptances and severity overrides', () => {
    expect(
      parse({
        $schema: 'https://example.com/schema.json',
        accept: [
          {
            rule: 'workflow/unpinned-action',
            file: './.github\\workflows\\ci.yml',
            subject: 'example-org/deploy@v2',
            reason: '  Our own action.  ',
          },
        ],
        rules: { 'workflow/missing-permissions': { severity: 'low' } },
      }),
    ).toEqual({
      accept: [
        {
          rule: 'workflow/unpinned-action',
          file: '.github/workflows/ci.yml',
          subject: 'example-org/deploy@v2',
          reason: 'Our own action.',
        },
      ],
      severity: { 'workflow/missing-permissions': 'low' },
    });
  });

  it('accepts an empty object, and a byte order mark from Windows editors', () => {
    expect(parse({})).toEqual(EMPTY_CONFIG);
    expect(parse('﻿{}')).toEqual(EMPTY_CONFIG);
  });

  it.each([
    ['{ "accept": [', /^devsweep\.config\.json: not valid JSON: /],
    [[], 'the file: must be an object'],
    [{ accepted: [] }, 'the file: unknown key "accepted". Allowed: $schema, accept, rules'],
    [{ accept: {} }, 'accept: must be a list'],
    [{ accept: ['x'] }, 'accept[0]: must be an object'],
    [
      { accept: [{ rule: 'workflow/unpinned-action', file: 'a.yml' }] },
      'accept[0]: "reason" is required. Say why this finding is acceptable.',
    ],
    [
      { accept: [{ rule: 'workflow/unpinned-action', file: 'a.yml', reason: '   ' }] },
      'accept[0]: "reason" is required. Say why this finding is acceptable.',
    ],
    [
      { accept: [{ rule: 'workflow/unpined-action', file: 'a.yml', reason: 'x' }] },
      'accept[0].rule: unknown rule "workflow/unpined-action". Known rules: ',
    ],
    [
      { accept: [{ rule: 'workflow/unpinned-action', line: 3, reason: 'x' }] },
      'accept[0]: unknown key "line". Allowed: rule, file, subject, reason',
    ],
    [
      { accept: [{ rule: 'workflow/unpinned-action', file: '', reason: 'x' }] },
      'accept[0].file: must be a non-empty string',
    ],
    [{ rules: { 'workflow/nope': { severity: 'low' } } }, 'rules["workflow/nope"]: unknown rule'],
    [
      { rules: { 'workflow/force-push': { severity: 'severe' } } },
      'rules["workflow/force-push"].severity: must be one of critical, high, medium, low',
    ],
    [
      { rules: { 'workflow/force-push': { enabled: false } } },
      'rules["workflow/force-push"]: unknown key "enabled". Allowed: severity',
    ],
  ] as const)('rejects %j with a clear message', (value, message) => {
    const attempt = () => parse(value);
    expect(attempt).toThrow(ConfigError);
    if (typeof message === 'string') expect(attempt).toThrow(`${CONFIG_FILE}: ${message}`);
    else expect(attempt).toThrow(message);
  });
});

describe('applyConfig', () => {
  it('moves a finding that matches rule, file and subject to the accepted list', () => {
    const config = parse({
      accept: [
        {
          rule: unpinned.ruleId,
          file: unpinned.file,
          subject: unpinned.subject,
          reason: 'Ours.',
        },
      ],
    });
    expect(applyConfig([unpinned, trigger], config)).toEqual({
      findings: [trigger],
      accepted: [{ ...unpinned, reason: 'Ours.' }],
      unused: [],
    });
  });

  it('ignores line numbers, since they move', () => {
    const config = parse({
      accept: [
        { rule: unpinned.ruleId, file: unpinned.file, subject: unpinned.subject, reason: 'x' },
      ],
    });
    expect(applyConfig([{ ...unpinned, line: 99 }], config).accepted).toHaveLength(1);
  });

  it('needs the subject to match, so new problems in the same file still show', () => {
    const config = parse({
      accept: [{ rule: unpinned.ruleId, file: unpinned.file, reason: 'x' }],
    });
    const result = applyConfig([unpinned], config);
    expect(result.findings).toEqual([unpinned]);
    expect(result.unused).toEqual([
      'accept[0] matches no finding (workflow/unpinned-action in .github/workflows/ci.yml). ' +
        'Remove it if the issue was fixed.',
    ]);
  });

  it('matches a finding with no subject when the acceptance has none', () => {
    const config = parse({ accept: [{ rule: trigger.ruleId, file: trigger.file, reason: 'x' }] });
    expect(applyConfig([trigger], config).accepted).toHaveLength(1);
  });

  it('overrides severity by rule, for open and accepted findings alike', () => {
    const config = parse({
      accept: [{ rule: trigger.ruleId, file: trigger.file, reason: 'x' }],
      rules: {
        'workflow/unpinned-action': { severity: 'low' },
        'workflow/pull-request-target': { severity: 'high' },
      },
    });
    const result = applyConfig([unpinned, trigger], config);
    expect(result.findings.map((f) => f.severity)).toEqual(['low']);
    expect(result.accepted.map((f) => f.severity)).toEqual(['high']);
  });
});

describe('loadConfig', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-config-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('returns an empty config when there is no file', async () => {
    expect(await loadConfig(temp, RULES)).toEqual(EMPTY_CONFIG);
  });

  it('reads the file from the scan root', async () => {
    await writeFile(path.join(temp, CONFIG_FILE), '{ "rules": {} }');
    expect(await loadConfig(temp, RULES)).toEqual(EMPTY_CONFIG);
  });
});

describe('scan with a config file', () => {
  it('applies the config in the scan root', async () => {
    const result = await scan({ root: fixture('configured-repo'), offline: true });
    expect(result.findings.map((f) => `${f.severity} ${f.ruleId} ${f.subject}`)).toEqual([
      'high workflow/unpinned-action example-org/report@v1',
      'low workflow/missing-permissions job build',
    ]);
    expect(result.accepted.map((f) => `${f.ruleId}: ${f.reason}`)).toEqual([
      'workflow/unpinned-action: Our own action, released from a protected tag.',
      'workflow/pull-request-target: Only adds labels; it never checks out or runs pull request code.',
    ]);
    expect(result.warnings).toEqual([
      {
        checkId: 'config',
        file: CONFIG_FILE,
        message: expect.stringMatching(/^accept\[2\] matches no finding/),
      },
    ]);
  });

  it('ignores the config file when told to', async () => {
    const result = await scan({ root: fixture('configured-repo'), config: false, offline: true });
    expect(result.findings).toHaveLength(4);
    expect(result.accepted).toEqual([]);
  });
});
