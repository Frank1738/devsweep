import type { ScanResult } from '../types.js';
import { summarize } from './summary.js';

/** Machine-readable output. The shape is part of the public interface: only add fields. */
export function formatJson(result: ScanResult, version: string): string {
  const report = {
    tool: { name: 'devsweep', version },
    root: result.root,
    durationMs: result.durationMs,
    summary: summarize(result.findings),
    findings: result.findings,
    warnings: result.warnings,
    errors: result.errors,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
