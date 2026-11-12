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
  properties: { 'security-severity': string };
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
            rules: rules.map(describeRule),
          },
        },
        // A top-level base may leave out its absolute location (SARIF §3.4.3), which keeps
        // local paths out of the file. GitHub resolves it to the checked-out repository.
        originalUriBaseIds: { [SRCROOT]: { description: { text: 'The repository root.' } } },
        // Columns come from JavaScript string offsets, which count UTF-16 code units.
        columnKind: 'utf16CodeUnits',
        invocations: [invocation(result, locate)],
        results: result.findings.map((finding) => {
          const index = ruleIndex.get(finding.ruleId);
          return {
            ruleId: finding.ruleId,
            ...(index !== undefined && { ruleIndex: index }),
            level: LEVELS[finding.severity],
            message: { text: finding.message },
            locations: [locate(finding.file, regionOf(finding, options.readLines))],
            // GitHub documents security-severity only on rules, but a rule like force-push varies
            // per finding. Repeating it here lets a reader that checks results use the right one.
            properties: { 'security-severity': SECURITY_SEVERITY[finding.severity] },
          };
        }),
      },
    ],
  };
}

function describeRule(rule: Rule): ReportingDescriptor {
  return {
    id: rule.id,
    shortDescription: { text: rule.title },
    fullDescription: { text: rule.description },
    help: {
      text: `${rule.description}\n\nHow to fix: ${rule.remediation}`,
      markdown: `${escapeMarkdown(rule.description)}\n\n## How to fix\n\n${escapeMarkdown(rule.remediation)}`,
    },
    defaultConfiguration: { level: LEVELS[rule.severity] },
    properties: {
      // The "security" tag is what makes GitHub read security-severity.
      tags: ['security', rule.id.split('/')[0] ?? rule.id],
      precision: 'high',
      'security-severity': SECURITY_SEVERITY[rule.severity],
    },
  };
}

/**
 * Where to highlight: from the finding's column to the end of the line's content, the same span
 * the terminal underlines. Without the file's text, only the start is known.
 */
function regionOf(finding: Finding, readLines: ReadLines | undefined): Region | undefined {
  if (finding.line === undefined) return undefined;
  const text = readLines?.(finding.file)?.[finding.line - 1];
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
