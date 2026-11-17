import type { RepositoryRef } from './github/repository.js';
import type { ReadDir } from './walk.js';

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
  /**
   * True when the line a finding points at may be malicious code, such as a hidden payload.
   * Reports then never print that line, not even as a code excerpt in `--details`.
   */
  hidesSource?: boolean;
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
  /**
   * Path relative to the scan root, always with forward slashes. Absent for findings about the
   * repository's settings on GitHub, which aren't in any file.
   */
  file?: string;
  line?: number;
  column?: number;
  /** What to do about it. */
  remediation?: string;
}

export interface ScanContext {
  /** Absolute path of the directory being scanned. */
  root: string;
  /**
   * Folders inside `root` that checks reading every file must leave out, as paths from `root`
   * with forward slashes. `--all` sets it to the projects nested in this one, which it scans on
   * their own, so no file is reported twice.
   */
  skipFolders?: readonly string[] | undefined;
  /** Report something the check couldn't analyze, without failing the scan. */
  warn(message: string, file?: string): void;
  /**
   * Record that the check found a file and read it, so the report can tell a folder with nothing
   * to scan apart from a clean one.
   */
  scannedFile(): void;
  /** Record that the repository's settings on GitHub were read. */
  scannedGitHub(): void;
  /**
   * The repository on GitHub, from the git remote or GITHUB_REPOSITORY. Looked up once per scan
   * and shared by every check that asks.
   */
  repository(): Promise<RepositoryRef | undefined>;
  /** Lists a folder. `--all` passes the listings it already read while searching for projects. */
  readdir?: ReadDir | undefined;
  /** True when the user asked for no network access (`--offline`). */
  offline: boolean;
  /** Environment variables, for tokens and CI settings. Never print token values. */
  env: Env;
  /** For calls to the GitHub API. Tests pass a fake. */
  fetch: typeof fetch;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** A group of related rules that share the work of finding and reading files. */
export interface Check {
  id: string;
  description: string;
  rules: readonly Rule[];
  /** True when the check calls the network. `--offline` skips it without running it. */
  network?: boolean;
  /**
   * The files this check reads, as shown to the user when none of them exist, e.g.
   * `.vscode/tasks.json`. Set on every check that reads files from the scanned folder.
   */
  looksFor?: readonly string[];
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

/** A finding that matches an acceptance in the config file. It doesn't fail the scan. */
export interface AcceptedFinding extends Finding {
  /** Why it was accepted, from the config file. */
  reason: string;
}

export interface ScanResult {
  root: string;
  /** Open findings: not accepted in the config file. */
  findings: Finding[];
  /** Findings accepted in the config file, with the reason given. */
  accepted: AcceptedFinding[];
  /** Things a check skipped or couldn't check. The rest of the scan still completed. */
  warnings: ScanWarning[];
  /** Checks that crashed. Their findings are missing from the result. */
  errors: ScanError[];
  durationMs: number;
  /**
   * Severities set by rule id in the config file. Findings already carry them; this is for
   * reports that also describe each rule, like SARIF. Absent when the config sets none.
   */
  severityOverrides?: Record<string, Severity>;
  /**
   * What the scan found to read. Without it, reports assume something was scanned, so results
   * built by hand (or by older code) read as before.
   */
  coverage?: Coverage;
}

/** What a scan found to read. Lets a report tell "nothing to scan" apart from "nothing wrong". */
export interface Coverage {
  /** True when the checks found at least one file to read. */
  filesRead: boolean;
  /** What the file-based checks that ran looked for, e.g. `.vscode/tasks.json`. */
  lookedFor: string[];
  /** True when the repository's settings on GitHub were read. */
  github: boolean;
}

export interface FindingInput {
  file?: string | undefined;
  at?: { line: number; column?: number | undefined } | undefined;
  message: string;
  subject?: string | undefined;
  /** What to do about this finding. Defaults to the rule's remediation. */
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
    ...(file !== undefined && { file }),
    ...(at && { line: at.line }),
    ...(at?.column !== undefined && { column: at.column }),
    remediation: remediation ?? rule.remediation,
  };
}

/** One project's results from a scan with `--all`. */
export interface ProjectScan {
  /** Path from the folder searched, with forward slashes. "." when it is that folder itself. */
  path: string;
  /**
   * The project's scan. A project whose scan couldn't start, such as one with a broken config
   * file, has no findings and one error saying why.
   */
  result: ScanResult;
}

/** The results of `--all`: every project found under a folder, each scanned on its own. */
export interface ScanAllResult {
  /** Absolute path of the folder searched. */
  root: string;
  /** Sorted by path. */
  projects: ProjectScan[];
  /** How many folders were searched for projects. */
  foldersSearched: number;
  /** Folders that couldn't be opened, such as ones without permission. Absolute paths, sorted. */
  unreadable: string[];
  durationMs: number;
}
