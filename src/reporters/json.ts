import type { ScanAllResult, ScanResult } from '../types.js';
import { summarize } from './summary.js';

/** Machine-readable output. The shape is part of the public interface: only add fields. */
export function formatJson(result: ScanResult, version: string): string {
  const report = { tool: { name: 'devsweep', version }, ...resultFields(result) };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * The `--all` report: totals, then each project's results in the same shape as a single scan's
 * report. The shape is part of the public interface: only add fields.
 */
export function formatJsonAll(all: ScanAllResult, version: string): string {
  const results = all.projects.map((project) => project.result);
  const report = {
    tool: { name: 'devsweep', version },
    root: all.root,
    durationMs: all.durationMs,
    // Network checks never run with --all.
    offline: true,
    summary: {
      projects: all.projects.length,
      projectsWithFindings: results.filter((r) => r.findings.length > 0).length,
      foldersSearched: all.foldersSearched,
      foldersUnreadable: all.unreadable.length,
      ...summarize(results.flatMap((r) => r.findings)),
      accepted: results.reduce((sum, r) => sum + r.accepted.length, 0),
    },
    unreadable: all.unreadable,
    projects: all.projects.map((project) => ({
      path: project.path,
      ...resultFields(project.result),
    })),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

function resultFields(result: ScanResult) {
  return {
    root: result.root,
    durationMs: result.durationMs,
    summary: { ...summarize(result.findings), accepted: result.accepted.length },
    findings: result.findings,
    accepted: result.accepted,
    warnings: result.warnings,
    errors: result.errors,
  };
}
