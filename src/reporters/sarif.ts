import { createHash } from 'node:crypto';
import { rules as builtInRules } from '../checks/index.js';
import type { Finding, Rule, ScanResult, Severity } from '../types.js';
import { markedSpan, type ReadLines } from './source.js';

/**
 * SARIF 2.1.0, the format GitHub code scanning reads. Field choices follow GitHub's "SARIF support
 * for code scanning" page. The output holds no timestamps or absolute paths, so it is the same on
 * every machine and safe to share.
 */

export interface SarifOptions {
  version: string;
  /** Every rule devsweep can report, in a fixed order. Defaults to the built-in rules. */
  rules?: readonly Rule[] | undefined;
  /**
   * Path from the repository root to the scan root, with forward slashes. GitHub needs paths
   * from the repository root, while findings are relative to the scan root.
   */
  pathFromRepoRoot?: string | undefined;
  /** Reads scanned files, to find where each highlighted region starts and ends. */
  readLines?: ReadLines | undefined;
}

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFORMATION_URI = 'https://github.com/Frank1738/devsweep';
/** Stands for the repository root, wherever it is checked out. */
const SRCROOT = '%SRCROOT%';

/**
 * GitHub needs a file and line for every alert, but repository settings aren't in a file. This
 * placeholder path says what the alert is about. Nothing is read from it. Every settings finding
 * shares it, so each one carries its own fingerprint (see settingsFingerprint) to stay a
 * separate alert.
 */
const SETTINGS_LOCATION: Location = {
  physicalLocation: {
    artifactLocation: { uri: 'github-repository-settings', uriBaseId: SRCROOT },
    region: { startLine: 1 },
  },
};

type Level = 'error' | 'warning' | 'note';

const LEVELS: Record<Severity, Level> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

/**
 * GitHub turns these scores into an alert's severity: over 9.0 is critical, 7.0 to 8.9 high,
 * 4.0 to 6.9 medium and 0.1 to 3.9 low. Each score sits well inside its band. GitHub rejects
 * the upload unless the value is a number written as a string.
 */
const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: '9.5',
  high: '8.0',
  medium: '5.5',
  low: '2.0',
};

interface Message {
  text: string;
}

interface Region {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

interface Location {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region?: Region;
  };
}

interface ReportingDescriptor {
  id: string;
  shortDescription: Message;
  fullDescription: Message;
  help: { text: string; markdown: string };
  defaultConfiguration: { level: Level };
  properties: { tags: string[]; precision: string; 'security-severity': string };
}

interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level: Level;
  message: Message;
  locations: Location[];
  partialFingerprints?: { primaryLocationLineHash: string };
  properties: { 'security-severity': string };
  suppressions?: { kind: 'external'; status: 'accepted'; justification: string }[];
}

interface Notification {
  level: 'warning' | 'error';
  message: Message;
  locations?: Location[];
  properties: { checkId: string };
}

interface Invocation {
  executionSuccessful: boolean;
  toolExecutionNotifications?: Notification[];
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: [
    {
      tool: {
        driver: {
          name: string;
          version: string;
          semanticVersion: string;
          informationUri: string;
          rules: ReportingDescriptor[];
        };
      };
      originalUriBaseIds: Record<string, { description: Message }>;
      columnKind: 'utf16CodeUnits';
      invocations: Invocation[];
      results: SarifResult[];
    },
  ];
}

export function formatSarif(result: ScanResult, options: SarifOptions): string {
  return `${JSON.stringify(toSarif(result, options), null, 2)}\n`;
}

export function toSarif(result: ScanResult, options: SarifOptions): SarifLog {
  const rules = options.rules ?? builtInRules;
  const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));
  const prefix = options.pathFromRepoRoot ? `${options.pathFromRepoRoot}/` : '';
  const locate = (file: string, region?: Region): Location => ({
    physicalLocation: {
      artifactLocation: { uri: toUri(prefix + file), uriBaseId: SRCROOT },
      ...(region && { region }),
    },
  });

  return {
    $schema: SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'devsweep',
            version: options.version,
            semanticVersion: options.version,
            informationUri: INFORMATION_URI,
            // GitHub reads security-severity from the rule, so overrides belong here too.
            rules: rules.map((rule) =>
              describeRule(rule, result.severityOverrides?.[rule.id] ?? rule.severity),
            ),
          },
        },
        // A top-level base may leave out its absolute location (SARIF §3.4.3), which keeps
        // local paths out of the file. GitHub resolves it to the checked-out repository.
        originalUriBaseIds: { [SRCROOT]: { description: { text: 'The repository root.' } } },
        // Columns come from JavaScript string offsets, which count UTF-16 code units.
        columnKind: 'utf16CodeUnits',
        invocations: [invocation(result, locate)],
        results: [
          ...result.findings.map(toResult),
          // Accepted findings stay in the report, marked as suppressed with the reason, so the
          // decision travels with the results. GitHub code scanning doesn't read suppressions
          // (as of November 2026), so it still shows them as open alerts.
          ...result.accepted.map((accepted) => ({
            ...toResult(accepted),
            suppressions: [
              {
                kind: 'external' as const,
                status: 'accepted' as const,
                justification: accepted.reason,
              },
            ],
          })),
        ],
      },
    ],
  };

  function toResult(finding: Finding): SarifResult {
    const index = ruleIndex.get(finding.ruleId);
    return {
      ruleId: finding.ruleId,
      ...(index !== undefined && { ruleIndex: index }),
      level: LEVELS[finding.severity],
      message: { text: finding.message },
      locations: [
        finding.file === undefined
          ? SETTINGS_LOCATION
          : locate(finding.file, regionOf(finding, options.readLines)),
      ],
      ...(finding.file === undefined && {
        partialFingerprints: { primaryLocationLineHash: settingsFingerprint(finding) },
      }),
      // GitHub documents security-severity only on rules, but a rule like force-push varies
      // per finding. Repeating it here lets a reader that checks results use the right one.
      properties: { 'security-severity': SECURITY_SEVERITY[finding.severity] },
    };
  }
}

/** `severity` is the rule's own, unless the config file overrides it. */
function describeRule(rule: Rule, severity: Severity): ReportingDescriptor {
  return {
    id: rule.id,
    shortDescription: { text: rule.title },
    fullDescription: { text: rule.description },
    help: {
      text: `${rule.description}\n\nHow to fix: ${rule.remediation}`,
      markdown: `${escapeMarkdown(rule.description)}\n\n## How to fix\n\n${escapeMarkdown(rule.remediation)}`,
    },
    defaultConfiguration: { level: LEVELS[severity] },
    properties: {
      // The "security" tag is what makes GitHub read security-severity.
      tags: ['security', rule.id.split('/')[0] ?? rule.id],
      precision: 'high',
      'security-severity': SECURITY_SEVERITY[severity],
    },
  };
}

/**
 * Where to highlight: from the finding's column to the end of the line's content, the same span
 * the terminal underlines. Without the file's text, only the start is known.
 */
function regionOf(finding: Finding, readLines: ReadLines | undefined): Region | undefined {
  if (finding.line === undefined) return undefined;
  const text =
    finding.file === undefined ? undefined : readLines?.(finding.file)?.[finding.line - 1];
  if (text === undefined) {
    return {
      startLine: finding.line,
      ...(finding.column !== undefined && { startColumn: finding.column }),
    };
  }
  const { start, end } = markedSpan(text, finding.column);
  return {
    startLine: finding.line,
    startColumn: start + 1,
    // SARIF's endColumn is the column just after the region.
    ...(end > start && { endLine: finding.line, endColumn: end + 1 }),
  };
}

/**
 * GitHub tells alerts apart by fingerprint. upload-sarif makes one from the code around a
 * finding's line, but settings findings all point at the same placeholder with no code, so
 * without this they could merge into one alert: the branch and the tags, or every recent force
 * push. The rule and subject say which problem it is, and stay the same from run to run while
 * the problem lasts. The format copies upload-sarif's own: a 16-digit hex hash, then ":1".
 */
function settingsFingerprint(finding: Finding): string {
  const hash = createHash('sha256').update(`${finding.ruleId}\0${finding.subject ?? ''}`);
  return `${hash.digest('hex').slice(0, 16)}:1`;
}

/** Skipped files become warnings, and crashed checks become errors that mark the run failed. */
function invocation(result: ScanResult, locate: (file: string) => Location): Invocation {
  const notifications: Notification[] = [
    ...result.warnings.map((warning) => ({
      level: 'warning' as const,
      message: { text: warning.message },
      ...(warning.file !== undefined && { locations: [locate(warning.file)] }),
      properties: { checkId: warning.checkId },
    })),
    ...result.errors.map((error) => ({
      level: 'error' as const,
      message: {
        text: `Check "${error.checkId}" failed, so its findings are missing: ${error.message}`,
      },
      properties: { checkId: error.checkId },
    })),
  ];
  return {
    executionSuccessful: result.errors.length === 0,
    ...(notifications.length > 0 && { toolExecutionNotifications: notifications }),
  };
}

/** Percent-encodes each path segment, so names with spaces or symbols still make a valid URI. */
function toUri(file: string): string {
  return file.split('/').map(encodeURIComponent).join('/');
}

/** Stops markdown from reading text as formatting, e.g. "<sha>" as an HTML tag. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&');
}
