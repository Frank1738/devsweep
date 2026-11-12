export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type Severity = (typeof SEVERITIES)[number];

/** A kind of problem devsweep can detect. Every finding points at exactly one rule. */
export interface Rule {
  /** Stable identifier, e.g. `workflow/unpinned-action`. Never rename a published rule. */
  id: string;
  /** Short, human-readable name. */
  title: string;
  severity: Severity;
  /** Why this is a risk. Used for help text and SARIF rule descriptions. */
  description: string;
  /** How to fix it in general. Findings carry their own, more specific advice. */
  remediation: string;
}

export interface Position {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

/** One problem found at one place. */
export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** A few words naming what was found, e.g. an action reference. Shown in compact output. */
  subject?: string;
  /** Path relative to the scan root, always with forward slashes. */
  file: string;
  line?: number;
  column?: number;
  /** What to do about it. */
  remediation?: string;
}

export interface ScanContext {
  /** Absolute path of the directory being scanned. */
  root: string;
  /** Report something the check couldn't analyze, without failing the scan. */
  warn(message: string, file?: string): void;
}

/** A group of related rules that share the work of finding and reading files. */
export interface Check {
  id: string;
  description: string;
  rules: readonly Rule[];
  run(ctx: ScanContext): Promise<Finding[]>;
}

export interface ScanWarning {
  checkId: string;
  message: string;
  file?: string;
}

export interface ScanError {
  checkId: string;
  message: string;
}

export interface ScanResult {
  root: string;
  findings: Finding[];
  /** Files or inputs a check skipped. The scan still completed. */
  warnings: ScanWarning[];
  /** Checks that crashed. Their findings are missing from the result. */
  errors: ScanError[];
  durationMs: number;
}

export interface FindingInput {
  file: string;
  at?: { line: number; column?: number | undefined } | undefined;
  message: string;
  subject?: string | undefined;
  remediation?: string | undefined;
  /** Overrides the rule's default severity for this one finding. */
  severity?: Severity | undefined;
}

export function createFinding(rule: Rule, input: FindingInput): Finding {
  const { file, at, message, subject, remediation, severity } = input;
  return {
    ruleId: rule.id,
    severity: severity ?? rule.severity,
    message,
    ...(subject !== undefined && { subject }),
    file,
    ...(at && { line: at.line }),
    ...(at?.column !== undefined && { column: at.column }),
    ...(remediation !== undefined && { remediation }),
  };
}
