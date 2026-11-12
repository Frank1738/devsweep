import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AcceptedFinding, Finding, Severity } from './types.js';
import { SEVERITIES } from './types.js';

/** Read from the scan root. */
export const CONFIG_FILE = 'devsweep.config.json';

/** A finding someone reviewed and decided to live with. */
export interface Acceptance {
  rule: string;
  /** Path relative to the scan root, with forward slashes. Absent for repository settings. */
  file?: string;
  /** Must equal the finding's subject. Absent only for findings that have none. */
  subject?: string;
  /** Why the finding is acceptable. Required, so every exception explains itself. */
  reason: string;
}

export interface Config {
  accept: Acceptance[];
  /** Severity overrides by rule id. */
  severity: Record<string, Severity>;
}

export const EMPTY_CONFIG: Config = { accept: [], severity: {} };

/** The config file is missing pieces, has a typo, or isn't valid JSON. The scan can't start. */
export class ConfigError extends Error {}

/** Reads the config file from `root`. No file means no config. */
export async function loadConfig(root: string, knownRules: readonly string[]): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path.join(root, CONFIG_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_CONFIG;
    throw new ConfigError(`${CONFIG_FILE}: couldn't read it: ${(error as Error).message}`);
  }
  return parseConfig(text, knownRules);
}

/**
 * Parses and checks a config file. Unknown keys and unknown rule ids are errors rather than
 * being ignored, because a typo in a security exception should never pass silently.
 */
export function parseConfig(text: string, knownRules: readonly string[]): Config {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILE}: not valid JSON: ${(error as Error).message}`);
  }

  const top = object(data, 'the file');
  allowKeys(top, ['$schema', 'accept', 'rules'], 'the file');
  const known = new Set(knownRules);
  const ruleId = (value: unknown, where: string): string => {
    const id = requiredString(value, where);
    if (!known.has(id)) {
      fail(`${where}: unknown rule "${id}". Known rules: ${[...known].join(', ')}`);
    }
    return id;
  };

  const accept = (top.accept === undefined ? [] : array(top.accept, 'accept')).map(
    (item, i): Acceptance => {
      const where = `accept[${i}]`;
      const entry = object(item, where);
      allowKeys(entry, ['rule', 'file', 'subject', 'reason'], where);
      if (
        entry.reason === undefined ||
        (typeof entry.reason === 'string' && !entry.reason.trim())
      ) {
        fail(`${where}: "reason" is required. Say why this finding is acceptable.`);
      }
      return {
        rule: ruleId(entry.rule, `${where}.rule`),
        ...(entry.file !== undefined && {
          file: normalizeFile(requiredString(entry.file, `${where}.file`)),
        }),
        ...(entry.subject !== undefined && {
          subject: requiredString(entry.subject, `${where}.subject`),
        }),
        reason: requiredString(entry.reason, `${where}.reason`).trim(),
      };
    },
  );

  const severity: Record<string, Severity> = {};
  const rules = top.rules === undefined ? {} : object(top.rules, 'rules');
  for (const [id, value] of Object.entries(rules)) {
    const where = `rules["${id}"]`;
    ruleId(id, where);
    const settings = object(value, where);
    allowKeys(settings, ['severity'], where);
    const level = settings.severity;
    if (!SEVERITIES.includes(level as Severity)) {
      fail(`${where}.severity: must be one of ${SEVERITIES.join(', ')}`);
    }
    severity[id] = level as Severity;
  }

  return { accept, severity };
}

export interface Configured {
  /** Findings still open, with severity overrides applied. */
  findings: Finding[];
  accepted: AcceptedFinding[];
  /** Acceptances that matched nothing, as warnings to clean up. */
  unused: string[];
}

/**
 * Applies severity overrides, then moves findings that match an acceptance out of the list.
 * `unchecked` picks out acceptances the scan couldn't confirm or rule out, for example because
 * their check was skipped. Those aren't reported as unused, since the finding may still exist.
 */
export function applyConfig(
  findings: readonly Finding[],
  config: Config,
  unchecked: (entry: Acceptance) => boolean = () => false,
): Configured {
  const used = new Set<number>();
  const open: Finding[] = [];
  const accepted: AcceptedFinding[] = [];

  for (const original of findings) {
    const override = config.severity[original.ruleId];
    const finding = override ? { ...original, severity: override } : original;
    const index = config.accept.findIndex((entry) => matches(entry, finding));
    const entry = config.accept[index];
    if (entry) {
      used.add(index);
      accepted.push({ ...finding, reason: entry.reason });
    } else {
      open.push(finding);
    }
  }

  const unused = config.accept.flatMap((entry, i) =>
    used.has(i) || unchecked(entry)
      ? []
      : [
          `accept[${i}] matches no finding (${entry.rule}${entry.file ? ` in ${entry.file}` : ''}). ` +
            'Remove it if the issue was fixed.',
        ],
  );
  return { findings: open, accepted, unused };
}

/**
 * Rule, file and subject must all match. Line numbers are left out on purpose: they move when
 * unrelated lines change. A missing subject only matches findings that have no subject, so one
 * acceptance can't quietly cover new problems added to the same file later.
 */
function matches(entry: Acceptance, finding: Finding): boolean {
  return (
    entry.rule === finding.ruleId &&
    entry.file === finding.file &&
    entry.subject === finding.subject
  );
}

function normalizeFile(file: string): string {
  return file.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
}

function fail(message: string): never {
  throw new ConfigError(`${CONFIG_FILE}: ${message}`);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where}: must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where}: must be a list`);
  return value;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${where}: must be a non-empty string`);
  return value;
}

function allowKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    fail(`${where}: unknown key "${unknown[0]}". Allowed: ${keys.join(', ')}`);
  }
}
