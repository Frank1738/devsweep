import { type Finding, type ScanResult, SEVERITIES } from './types.js';

/** CI systems read the exit code to pass or fail a job. */
export const EXIT_OK = 0;
/** Findings at or above the --fail-on threshold. */
export const EXIT_FINDINGS = 1;
/** Bad options, a path that can't be scanned, a report that can't be saved, or a crashed check. */
export const EXIT_TOOL_ERROR = 2;

export const FAIL_ON = [...SEVERITIES, 'none'] as const;
export type FailOn = (typeof FAIL_ON)[number];
/** Any finding fails. A security gate that passes by default gives false confidence. */
export const DEFAULT_FAIL_ON: FailOn = 'low';

/** The findings at or above `failOn`. */
export function failingFindings(findings: readonly Finding[], failOn: FailOn): Finding[] {
  if (failOn === 'none') return [];
  const threshold = SEVERITIES.indexOf(failOn);
  return findings.filter((finding) => SEVERITIES.indexOf(finding.severity) <= threshold);
}

/**
 * A crashed check means the result can't be trusted, so that wins over findings, as with grep.
 * Skipped files are only warnings and don't change the exit code: the rest of the scan finished.
 */
export function exitCodeFor(result: ScanResult, failOn: FailOn): number {
  if (result.errors.length > 0) return EXIT_TOOL_ERROR;
  return failingFindings(result.findings, failOn).length > 0 ? EXIT_FINDINGS : EXIT_OK;
}
