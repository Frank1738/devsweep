import { stat } from 'node:fs/promises';
import path from 'node:path';
import { checks as defaultChecks } from './checks/index.js';
import { compareText } from './compare.js';
import {
  type Acceptance,
  applyConfig,
  CONFIG_FILE,
  type Config,
  EMPTY_CONFIG,
  loadConfig,
} from './config.js';
import { errorMessage } from './errors.js';
import {
  type Check,
  type Env,
  type Finding,
  type ScanError,
  type ScanResult,
  type ScanWarning,
  SEVERITIES,
} from './types.js';

export interface ScanOptions {
  /** Directory to scan. Relative paths resolve against the current working directory. */
  root: string;
  /** Checks to run. Defaults to every built-in check. */
  checks?: readonly Check[];
  /**
   * Accepted findings and severity overrides. By default they're read from devsweep.config.json
   * in the scan root; `false` ignores that file.
   */
  config?: Config | false;
  /** Skip checks that need the network (the GitHub API). */
  offline?: boolean | undefined;
  /** Where tokens and CI settings are read from. Defaults to process.env. */
  env?: Env | undefined;
  /** Used for GitHub API calls. Defaults to the global fetch; tests pass a fake. */
  fetch?: typeof fetch | undefined;
}

export class ScanTargetError extends Error {}

/** Rejects with ScanTargetError for a bad path, or ConfigError for a bad config file. */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const started = performance.now();
  const root = path.resolve(options.root);
  await assertDirectory(root);
  const checks = options.checks ?? defaultChecks;
  const config =
    options.config === false
      ? EMPTY_CONFIG
      : (options.config ??
        (await loadConfig(
          root,
          checks.flatMap((check) => check.rules.map((rule) => rule.id)),
        )));

  const warnings: ScanWarning[] = [];
  const errors: ScanError[] = [];
  const offline = options.offline ?? false;
  const skipped = offline ? checks.filter((check) => check.network) : [];

  const perCheck = await Promise.all(
    checks
      .filter((check) => !skipped.includes(check))
      .map(async (check) => {
        try {
          return await check.run({
            root,
            warn: (message, file) =>
              warnings.push({ checkId: check.id, message, ...(file !== undefined && { file }) }),
            offline,
            env: options.env ?? process.env,
            fetch: options.fetch ?? globalThis.fetch,
          });
        } catch (error) {
          errors.push({ checkId: check.id, message: errorMessage(error) });
          return [];
        }
      }),
  );

  const configured = applyConfig(
    perCheck.flat(),
    config,
    notFullyChecked(checks, skipped, warnings, errors),
  );
  // Checks run at the same time, so their warnings arrive in whatever order they finish.
  // Warnings about the config file come after them, in the file's order.
  warnings.sort(
    (a, b) =>
      compareText(a.checkId, b.checkId) ||
      compareText(a.file ?? '', b.file ?? '') ||
      compareText(a.message, b.message),
  );
  for (const message of configured.unused) {
    warnings.push({ checkId: 'config', message, file: CONFIG_FILE });
  }

  return {
    root,
    findings: configured.findings.sort(compareFindings),
    accepted: configured.accepted.sort(compareFindings),
    warnings,
    errors,
    durationMs: Math.round(performance.now() - started),
    ...(Object.keys(config.severity).length > 0 && {
      severityOverrides: { ...config.severity },
    }),
  };
}

/**
 * Picks out acceptances whose check didn't fully run: it was skipped, it crashed, or it warned
 * that it couldn't check something. A warning that names a file covers only that file.
 */
function notFullyChecked(
  checks: readonly Check[],
  skipped: readonly Check[],
  warnings: readonly ScanWarning[],
  errors: readonly ScanError[],
): (entry: Acceptance) => boolean {
  const checkOfRule = new Map(
    checks.flatMap((check) => check.rules.map((rule) => [rule.id, check.id] as const)),
  );
  const wholeCheck = new Set([...skipped.map((c) => c.id), ...errors.map((e) => e.checkId)]);
  const filesOfCheck = new Map<string, Set<string>>();
  for (const { checkId, file } of warnings) {
    if (file === undefined) wholeCheck.add(checkId);
    else filesOfCheck.set(checkId, (filesOfCheck.get(checkId) ?? new Set()).add(file));
  }

  return (entry) => {
    const checkId = checkOfRule.get(entry.rule);
    if (checkId === undefined) return false;
    if (wholeCheck.has(checkId)) return true;
    return entry.file !== undefined && (filesOfCheck.get(checkId)?.has(entry.file) ?? false);
  };
}

/** Most severe first, then by file and position, so output is stable between runs. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    compareText(a.file ?? '', b.file ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareText(a.ruleId, b.ruleId) ||
    compareText(a.subject ?? '', b.subject ?? '')
  );
}

async function assertDirectory(root: string): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(root)).isDirectory();
  } catch {
    throw new ScanTargetError(`Path does not exist: ${root}`);
  }
  if (!isDirectory) throw new ScanTargetError(`Path is not a directory: ${root}`);
}
