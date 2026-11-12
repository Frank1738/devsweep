import path from 'node:path';
import pc from 'picocolors';
import { rules } from '../checks/index.js';
import { type Finding, type ScanResult, SEVERITIES, type Severity } from '../types.js';
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
  readLines?: ((file: string) => string[] | undefined) | undefined;
}

type Colors = ReturnType<typeof pc.createColors>;
type Paint = (text: string) => string;

interface Group {
  file: string;
  findings: Finding[];
}

const TITLES = new Map(rules.map((rule) => [rule.id, rule.title]));
const DOT = '●';
const SEVERITY_WIDTH = Math.max(...SEVERITIES.map((s) => s.length));
/** Upper bound for wrapped text, so details stay readable on very wide terminals. */
const MAX_TEXT_WIDTH = 100;

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

  const lines =
    options.showName === false
      ? [`  ${c.dim(`Results for ${options.target}`)}`, '']
      : ['', `  ${c.bold(c.cyan('devsweep'))}  ${c.dim(options.target)}`, ''];
  for (const group of groups) {
    lines.push(`  ${formatPath(group.file, c)}`);
    if (options.details) {
      lines.push('', ...group.findings.flatMap((f) => detailed(f, c, paint, options)));
    } else {
      lines.push(...compact(group.findings, result.findings, c, paint, width), '');
    }
  }

  const notices = [
    ...result.warnings.map(
      (w) =>
        `  ${c.yellow('!')} ${truncate(`${w.file ? `${w.file}  ` : ''}${firstLine(w.message)}`, width, 4)}`,
    ),
    ...result.errors.map(
      (e) =>
        `  ${c.red('×')} ${truncate(`check "${e.checkId}" failed: ${firstLine(e.message)}`, width, 4)}`,
    ),
  ];
  if (notices.length > 0) lines.push(...notices, '');

  lines.push(...summary(result, c, paint, options.details ?? false));
  return `${lines.join('\n')}\n`;
}

/** One line per finding: severity, line number, title and a short subject. */
function compact(
  findings: Finding[],
  all: Finding[],
  c: Colors,
  paint: Record<Severity, Paint>,
  width: number | undefined,
): string[] {
  // Align columns across every group, so the whole list reads as one table.
  const lineWidth = Math.max(...all.map((f) => String(f.line ?? '').length));
  const titleWidth = Math.max(...all.map((f) => title(f).length));
  const used = 4 + 2 + SEVERITY_WIDTH + 2 + lineWidth + 2 + titleWidth + 2;

  return findings.map((f) => {
    const severity = paint[f.severity](`${DOT} ${f.severity.padEnd(SEVERITY_WIDTH)}`);
    const line = c.dim(String(f.line ?? '').padStart(lineWidth));
    const head = `    ${severity}  ${line}  ${title(f)}`;
    if (!f.subject) return head;
    const gap = ' '.repeat(titleWidth - title(f).length + 2);
    return `${head}${gap}${c.dim(truncate(f.subject, width, used))}`;
  });
}

/** The explanation, a code excerpt pointing at the problem, and the fix. */
function detailed(
  f: Finding,
  c: Colors,
  paint: Record<Severity, Paint>,
  options: PrettyOptions,
): string[] {
  const textWidth = Math.min(options.width ?? MAX_TEXT_WIDTH, MAX_TEXT_WIDTH) - 6;
  const indent = (text: string) => `      ${text}`;
  const lines = [
    `    ${paint[f.severity](`${DOT} ${f.severity}`)}  ${c.bold(title(f))}${f.line ? c.dim(`  line ${f.line}`) : ''}`,
    ...wrap(f.message, textWidth).map(indent),
  ];

  const excerpt = codeExcerpt(f, options.readLines, textWidth, c, paint[f.severity]);
  if (excerpt.length > 0) lines.push('', ...excerpt.map(indent));

  if (f.remediation) {
    const fix = wrap(`Fix: ${f.remediation}`, textWidth);
    lines.push(
      '',
      ...fix.map((line, i) => indent(i === 0 ? line.replace(/^Fix:/, c.green('Fix:')) : line)),
    );
  }
  lines.push(indent(c.dim(f.ruleId)), '');
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
  if (f.line === undefined || !readLines) return [];
  const source = readLines(f.file);
  const target = source?.[f.line - 1];
  if (!source || target === undefined) return [];

  const gutter = String(f.line).length;
  const room = textWidth - gutter - 3;
  const show = (text: string) => (text.length > room ? `${text.slice(0, room - 1)}…` : text);
  const lines: string[] = [];

  const above = source[f.line - 2];
  if (above?.trim())
    lines.push(`${c.dim(`${String(f.line - 1).padStart(gutter)} │`)} ${c.dim(show(above))}`);
  lines.push(`${c.dim(`${String(f.line).padStart(gutter)} │`)} ${show(target)}`);

  const from = f.column !== undefined ? f.column - 1 : target.length - target.trimStart().length;
  const to = Math.min(target.trimEnd().length, room - 1);
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
  const skipped = result.warnings.length;
  const extra = `${skipped > 0 ? `  ${c.yellow(`· ${skipped} skipped`)}` : ''}  ${c.dim(`· ${result.durationMs} ms`)}`;
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
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.file) ?? [];
    group.push(finding);
    groups.set(finding.file, group);
  }
  return [...groups].map(([file, list]) => ({ file, findings: list }));
}

function title(f: Finding): string {
  return TITLES.get(f.ruleId) ?? f.ruleId;
}

function formatPath(file: string, c: Colors): string {
  const dir = path.posix.dirname(file);
  return `${dir === '.' ? '' : c.dim(`${dir}/`)}${c.bold(path.posix.basename(file))}`;
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

/** Word-wraps `text` to `width` columns. Words longer than a line are split across lines. */
export function wrap(text: string, width: number): string[] {
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
