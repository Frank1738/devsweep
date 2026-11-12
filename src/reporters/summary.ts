import { type Finding, SEVERITIES, type Severity } from '../types.js';

export type Summary = { total: number } & Record<Severity, number>;

export function summarize(findings: readonly Finding[]): Summary {
  const summary = { total: findings.length } as Summary;
  for (const severity of SEVERITIES) {
    summary[severity] = findings.filter((f) => f.severity === severity).length;
  }
  return summary;
}
