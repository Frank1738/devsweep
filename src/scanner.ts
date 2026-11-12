import { stat } from 'node:fs/promises';
import path from 'node:path';
import { checks as defaultChecks } from './checks/index.js';
import {
  type Check,
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
}

export class ScanTargetError extends Error {}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const started = performance.now();
  const root = path.resolve(options.root);
  await assertDirectory(root);

  const warnings: ScanWarning[] = [];
  const errors: ScanError[] = [];

  const perCheck = await Promise.all(
    (options.checks ?? defaultChecks).map(async (check) => {
      try {
        return await check.run({
          root,
          warn: (message, file) =>
            warnings.push({ checkId: check.id, message, ...(file !== undefined && { file }) }),
        });
      } catch (error) {
        errors.push({ checkId: check.id, message: errorMessage(error) });
        return [];
      }
    }),
  );

  return {
    root,
    findings: perCheck.flat().sort(compareFindings),
    warnings,
    errors,
    durationMs: Math.round(performance.now() - started),
  };
}

/** Most severe first, then by file and position, so output is stable between runs. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    a.file.localeCompare(b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    a.ruleId.localeCompare(b.ruleId)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
