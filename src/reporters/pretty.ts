import path from 'node:path';
import pc from 'picocolors';
import { rules } from '../checks/index.js';
import { type Finding, type ScanResult, SEVERITIES, type Severity } from '../types.js';
import { printable } from '../ui/terminal.js';
import { markedSpan, type ReadLines } from './source.js';
import { summarize } from './summary.js';

export interface PrettyOptions {
  /** What was scanned, as shown to the user. */
  target: string;
  color: boolean;
  /** False when the banner is already on screen, so the header doesn't repeat the name. */
  showName?: boolean | undefined;
  /** Explain every finding, with a code excerpt and the fix. */
  details?: boolean | undefined;
  /** Terminal width in columns. Without it, nothing is shortened or wrapped to fit. */
  width?: number | undefined;
  /** Reads a scanned file's lines, for code excerpts in details mode. */
  readLines?: ReadLines | undefined;
}

type Colors = ReturnType<typeof pc.createColors>;
type Paint = (text: string) => string;

interface Group {
  /** Undefined for findings about the repository's settings on GitHub. */
  file: string | undefined;
  findings: Finding[];
}

/** Widths of the compact list's columns, in characters. */
interface Columns {
  line: number;
  title: number;
}

const TITLES = new Map(rules.map((rule) => [rule.id, rule.title]));
const DOT = '●';
const SEVERITY_WIDTH = Math.max(...SEVERITIES.map((s) => s.length));
/** Upper bound for wrapped text, so details stay readable on very wide terminals. */
const MAX_TEXT_WIDTH = 100;
/** Lower bound, for terminals too narrow to fit details. Lines run over rather than vanish. */
const MIN_TEXT_WIDTH = 20;

/**
 * The readable report. Findings, warnings and code excerpts hold text from the scanned files and
 * from GitHub, so every piece of it goes through printable() before it reaches the terminal.
 */
export function formatPretty(result: ScanResult, options: PrettyOptions): string {
  const c = pc.createColors(options.color);
  const paint: Record<Severity, Paint> = {
    critical: (text) => c.bold(c.red(text)),
    high: c.red,
    medium: c.yellow,
    low: c.cyan,
  };
  const groups = groupByFile(result.findings);
  const width = options.width;
  // The compact list aligns columns across every group, so the whole list reads as one table.
  const columns = columnWidths(result.findings);

  const lines =
    options.showName === false
      ? [`  ${c.dim(`Results for ${options.target}`)}`, '']
      : ['', `  ${c.bold(c.cyan('devsweep'))}  ${c.dim(options.target)}`, ''];
  for (const group of groups) {
    lines.push(
      `  ${group.file === undefined ? c.bold('GitHub repository settings') : formatPath(group.file, c)}`,
    );
    if (options.details) {
      lines.push('', ...group.findings.flatMap((f) => detailed(f, c, paint, options)));
    } else {
      lines.push(...compact(group.findings, columns, c, paint, width), '');
    }
  }

  const notices = [
    ...result.warnings.map(
      (w) =>
        `  ${c.yellow('!')} ${truncate(printable(`${w.file ? `${w.file}  ` : ''}${firstLine(w.message)}`, true), width, 4)}`,
    ),
    ...result.errors.map(
      (e) =>
        `  ${c.red('×')} ${truncate(printable(`check "${e.checkId}" failed: ${firstLine(e.message)}`, true), width, 4)}`,
    ),
  ];
  if (notices.length > 0) lines.push(...notices, '');

  lines.push(...summary(result, c, paint, options.details ?? false));
  return `${lines.join('\n')}\n`;
}

/** One line per finding: severity, line number, title and a short subject. */
function compact(
  findings: Finding[],
  columns: Columns,
  c: Colors,
  paint: Record<Severity, Paint>,
  width: number | undefined,
): string[] {
  const used = 4 + 2 + SEVERITY_WIDTH + 2 + columns.line + 2 + columns.title + 2;

  return findings.map((f) => {
    const severity = paint[f.severity](`${DOT} ${f.severity.padEnd(SEVERITY_WIDTH)}`);
    const line = c.dim(String(f.line ?? '').padStart(columns.line));
    const head = `    ${severity}  ${line}  ${title(f)}`;
    if (!f.subject) return head;
    const gap = ' '.repeat(columns.title - title(f).length + 2);
    return `${head}${gap}${c.dim(truncate(printable(f.subject, true), width, used))}`;
  });
}

function columnWidths(findings: readonly Finding[]): Columns {
  return {
    line: Math.max(...findings.map((f) => String(f.line ?? '').length)),
    title: Math.max(...findings.map((f) => title(f).length)),
  };
}

/** The explanation, a code excerpt pointing at the problem, and the fix. */
function detailed(
  f: Finding,
  c: Colors,
  paint: Record<Severity, Paint>,
  options: PrettyOptions,
): string[] {
  const textWidth = Math.max(
    Math.min(options.width ?? MAX_TEXT_WIDTH, MAX_TEXT_WIDTH) - 6,
    MIN_TEXT_WIDTH,
  );
  const indent = (text: string) => `      ${text}`;
  const lines = [
    `    ${paint[f.severity](`${DOT} ${f.severity}`)}  ${c.bold(title(f))}${f.line ? c.dim(`  line ${f.line}`) : ''}`,
    ...wrap(printable(f.message), textWidth).map(indent),
  ];

  const excerpt = codeExcerpt(f, options.readLines, textWidth, c, paint[f.severity]);
  if (excerpt.length > 0) lines.push('', ...excerpt.map(indent));

  if (f.remediation) {
    const fix = wrap(`Fix: ${printable(f.remediation)}`, textWidth);
    lines.push(
      '',
      ...fix.map((line, i) => indent(i === 0 ? line.replace(/^Fix:/, c.green('Fix:')) : line)),
    );
  }
  lines.push(indent(c.dim(printable(f.ruleId, true))), '');
  return lines;
}

/** The finding's line and the one above it, with a marker under the problem. */
function codeExcerpt(
  f: Finding,
  readLines: PrettyOptions['readLines'],
  textWidth: number,
  c: Colors,
  paint: Paint,
): string[] {
  if (f.file === undefined || f.line === undefined || !readLines) return [];
  const source = readLines(f.file);
  const sourceLine = (n: number) => {
    const text = source?.[n - 1];
    return text === undefined ? undefined : printable(text, true);
  };
  const target = sourceLine(f.line);
  if (target === undefined) return [];

  const gutter = String(f.line).length;
  const room = textWidth - gutter - 3;
  const show = (text: string) => (text.length > room ? `${text.slice(0, room - 1)}…` : text);
  const lines: string[] = [];

  const above = sourceLine(f.line - 1);
  if (above?.trim())
    lines.push(`${c.dim(`${String(f.line - 1).padStart(gutter)} │`)} ${c.dim(show(above))}`);
  lines.push(`${c.dim(`${String(f.line).padStart(gutter)} │`)} ${show(target)}`);

  const span = markedSpan(target, f.column);
  const from = span.start;
  const to = Math.min(span.end, room - 1);
  if (to > from) {
    lines.push(
      `${c.dim(`${' '.repeat(gutter)} │`)} ${' '.repeat(from)}${paint('^'.repeat(to - from))}`,
    );
  }
  return lines;
}

function summary(
  result: ScanResult,
  c: Colors,
  paint: Record<Severity, Paint>,
  details: boolean,
): string[] {
  const accepted = result.accepted.length;
  const warned = result.warnings.length;
  const extra = [
    accepted > 0 ? c.dim(`· ${accepted} accepted`) : '',
    warned > 0 ? c.yellow(`· ${warned} ${warned === 1 ? 'warning' : 'warnings'}`) : '',
    c.dim(`· ${result.durationMs} ms`),
  ]
    .filter(Boolean)
    .map((part) => `  ${part}`)
    .join('');
  const failed = result.errors.length;
  const lines =
    failed > 0
      ? [
          `  ${c.red('×')} ${c.bold('Scan incomplete:')} ${failed} ${failed === 1 ? 'check' : 'checks'} failed, so some issues may be missing.`,
        ]
      : [];

  const counts = summarize(result.findings);
  if (counts.total === 0) {
    lines.push(`  ${failed > 0 ? c.dim(DOT) : c.green(DOT)} No issues found${extra}`);
    return lines;
  }

  const bySeverity = SEVERITIES.filter((s) => counts[s] > 0).map((s) =>
    paint[s](`${counts[s]} ${s}`),
  );
  const issues = c.bold(`${counts.total} ${counts.total === 1 ? 'issue' : 'issues'}`);
  lines.push(`  ${issues}  ${bySeverity.join('  ')}${extra}`);
  if (!details) lines.push(c.dim('  Add --details to see why each one matters and how to fix it.'));
  return lines;
}

/** Groups findings by file. Files with the most severe findings come first. */
function groupByFile(findings: readonly Finding[]): Group[] {
  const groups = new Map<string | undefined, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.file) ?? [];
    group.push(finding);
    groups.set(finding.file, group);
  }
  return [...groups].map(([file, list]) => ({ file, findings: list }));
}

function title(f: Finding): string {
  return TITLES.get(f.ruleId) ?? printable(f.ruleId, true);
}

function formatPath(file: string, c: Colors): string {
  const safe = printable(file, true);
  const dir = path.posix.dirname(safe);
  return `${dir === '.' ? '' : c.dim(`${dir}/`)}${c.bold(path.posix.basename(safe))}`;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

/** Shortens `text` with an ellipsis so it fits after `used` columns. Never below 12 characters. */
function truncate(text: string, width: number | undefined, used: number): string {
  if (width === undefined) return text;
  const room = Math.max(width - used - 1, 12);
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

/**
 * Word-wraps `text` to `width` columns. Words longer than a line are split across lines. A width
 * below 1 counts as 1, since splitting a word into zero-length pieces would never finish.
 */
export function wrap(text: string, columns: number): string[] {
  const width = Math.max(columns, 1);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > width) {
      if (current) lines.push(current);
      current = '';
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (current && current.length + 1 + rest.length > width) {
      lines.push(current);
      current = rest;
    } else {
      current = current ? `${current} ${rest}` : rest;
    }
  }
  if (current) lines.push(current);
  return lines;
}
