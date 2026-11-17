import path from 'node:path';
import pc from 'picocolors';
import { rules } from '../checks/index.js';
import { count, list, plural } from '../format.js';
import {
  type Finding,
  type ScanAllResult,
  type ScanResult,
  SEVERITIES,
  type Severity,
} from '../types.js';
import { printable } from '../ui/terminal.js';
import { PROJECT_MARKERS } from '../walk.js';
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
/** Rules whose findings may point at malicious code: their lines are never printed. */
const HIDES_SOURCE = new Set(rules.filter((rule) => rule.hidesSource).map((rule) => rule.id));
/** Shown in place of the code excerpt for those rules. */
export const SOURCE_HIDDEN_NOTE =
  "The line isn't shown here, since it may hold malicious code. Open the file in a plain text editor to read it.";
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
  const paint = painter(c);
  const lines = header(`Results for ${options.target}`, options.target, c, options.showName);
  // The compact list aligns columns across every group, so the whole list reads as one table.
  lines.push(...resultBody(result, columnWidths(result.findings), c, paint, options));
  lines.push(...summary(result, c, paint, options.details ?? false, options.width));
  return `${lines.join('\n')}\n`;
}

export interface PrettyAllOptions extends Omit<PrettyOptions, 'readLines'> {
  /** Reads a project's file lines, for code excerpts in details mode. Given the project's root. */
  readerFor?: ((root: string) => ReadLines) | undefined;
}

/** Shown once at the top of every `--all` report. */
export const ALL_OFFLINE_NOTE =
  'Network checks are off with --all, as if --offline were passed: checking the GitHub settings of dozens of repositories would hit GitHub’s rate limit. Scan one repository without --all to include them.';

/** How many unreadable folders the readable report names. JSON lists them all. */
const UNREADABLE_SHOWN = 5;

/**
 * The readable `--all` report: findings grouped by project, then by file, and one summary for
 * everything. Projects with nothing to report are counted but not listed.
 */
export function formatPrettyAll(all: ScanAllResult, options: PrettyAllOptions): string {
  const c = pc.createColors(options.color);
  const paint = painter(c);
  const width = options.width;
  const inner = { ...options, width: width === undefined ? undefined : width - 2 };
  const lines = header(
    `Results for every project under ${options.target}`,
    `${options.target}  · every project`,
    c,
    options.showName,
  );
  lines.push(...wrap(ALL_OFFLINE_NOTE, textWidthAfter(2, width)).map((l) => c.dim(`  ${l}`)), '');

  const shown = all.projects.filter(
    ({ result }) => result.findings.length + result.warnings.length + result.errors.length > 0,
  );
  // One table across every project, so the columns line up all the way down.
  const columns = columnWidths(shown.flatMap(({ result }) => result.findings));
  for (const { path: projectPath, result } of shown) {
    const name = projectPath === '.' ? '. (the folder itself)' : printable(projectPath, true);
    lines.push(`  ${c.bold(c.cyan(name))}`);
    const body = resultBody(result, columns, c, paint, {
      ...inner,
      readLines: options.readerFor?.(result.root),
    });
    lines.push(...body.map((line) => (line ? `  ${line}` : line)));
  }

  if (all.unreadable.length > 0) {
    const unreadableCount = all.unreadable.length;
    const names = all.unreadable
      .slice(0, UNREADABLE_SHOWN)
      .map((dir) => `    ${printable(dir, true)}`);
    lines.push(
      ...notice(
        c.yellow('!'),
        `${plural(unreadableCount, 'folder')} couldn't be opened and ${unreadableCount === 1 ? 'was' : 'were'} skipped, usually for lack of permission:`,
        width,
      ),
      ...names,
    );
    if (unreadableCount > UNREADABLE_SHOWN) {
      lines.push(
        c.dim(`    …and ${unreadableCount - UNREADABLE_SHOWN} more (--json lists them all)`),
      );
    }
    lines.push('');
  }

  lines.push(...summaryAll(all, c, paint, options.details ?? false, width));
  return `${lines.join('\n')}\n`;
}

function painter(c: Colors): Record<Severity, Paint> {
  return {
    critical: (text) => c.bold(c.red(text)),
    high: c.red,
    medium: c.yellow,
    low: c.cyan,
  };
}

/** The report's first lines. Without the banner on screen, it names devsweep too. */
function header(
  withBanner: string,
  withoutBanner: string,
  c: Colors,
  showName: boolean | undefined,
): string[] {
  return showName === false
    ? [`  ${c.dim(withBanner)}`, '']
    : ['', `  ${c.bold(c.cyan('devsweep'))}  ${c.dim(withoutBanner)}`, ''];
}

/** Findings grouped by file, then warnings and errors. Ends with a blank line when not empty. */
function resultBody(
  result: ScanResult,
  columns: Columns,
  c: Colors,
  paint: Record<Severity, Paint>,
  options: PrettyOptions,
): string[] {
  const width = options.width;
  const lines: string[] = [];
  for (const group of groupByFile(result.findings)) {
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
    ...result.warnings.flatMap((w) => notice(c.yellow('!'), w.message, width, w.file || undefined)),
    ...result.errors.flatMap((e) =>
      // A config error names the file itself; "check config failed" would read oddly.
      notice(
        c.red('×'),
        e.checkId === 'config' ? e.message : `check "${e.checkId}" failed: ${e.message}`,
        width,
      ),
    ),
  ];
  if (notices.length > 0) lines.push(...notices, '');
  return lines;
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
  const textWidth = textWidthAfter(6, options.width);
  const indent = (text: string) => `      ${text}`;
  const lines = [
    `    ${paint[f.severity](`${DOT} ${f.severity}`)}  ${c.bold(title(f))}${f.line ? c.dim(`  line ${f.line}`) : ''}`,
    ...wrap(printable(f.message), textWidth).map(indent),
  ];

  if (HIDES_SOURCE.has(f.ruleId)) {
    lines.push('', ...wrap(SOURCE_HIDDEN_NOTE, textWidth).map((line) => indent(c.dim(line))));
  } else {
    const excerpt = codeExcerpt(f, options.readLines, textWidth, c, paint[f.severity]);
    if (excerpt.length > 0) lines.push('', ...excerpt.map(indent));
  }

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

/**
 * A warning or error, word-wrapped like the details text, with later lines indented under the
 * text. A file name comes first, set off by two spaces.
 */
function notice(mark: string, message: string, width: number | undefined, file?: string): string[] {
  const room = textWidthAfter(4, width);
  const body = printable(firstLine(message), true);
  const name = file === undefined ? undefined : printable(file, true);
  let lines: string[];
  if (name === undefined) {
    lines = wrap(body, room);
  } else {
    // wrap() joins words with one space; leave room for the second one after the file name.
    lines = wrap(`${name} ${body}`, room - 1);
    const first = lines[0];
    if (first?.startsWith(`${name} `)) lines[0] = `${name}  ${first.slice(name.length + 1)}`;
  }
  return lines.map((line, i) => `${i === 0 ? `  ${mark} ` : '    '}${line}`);
}

/** Room for wrapped text after `indent` columns, within the bounds above. */
function textWidthAfter(indent: number, width: number | undefined): number {
  return Math.max(Math.min(width ?? MAX_TEXT_WIDTH, MAX_TEXT_WIDTH) - indent, MIN_TEXT_WIDTH);
}

/**
 * Says what was scanned when it wasn't the files: either nothing at all, or only the settings on
 * GitHub. Undefined when files were read, or when a check crashed (the summary says so already).
 */
function coverageNote(result: ScanResult): { nothing: boolean; text: string } | undefined {
  const coverage = result.coverage;
  if (!coverage || coverage.filesRead || result.errors.length > 0) return undefined;
  const lookedFor =
    coverage.lookedFor.length > 0
      ? `devsweep looks for ${list(coverage.lookedFor)}, and found none here.`
      : '';
  if (coverage.github) {
    return {
      nothing: false,
      text: `Only the GitHub repository settings were checked. ${lookedFor}`.trim(),
    };
  }
  return { nothing: true, text: lookedFor };
}

function summary(
  result: ScanResult,
  c: Colors,
  paint: Record<Severity, Paint>,
  details: boolean,
  width: number | undefined,
): string[] {
  const failed = result.errors.length;
  const lines =
    failed > 0
      ? [
          `  ${c.red('×')} ${c.bold('Scan incomplete:')} ${plural(failed, 'check')} failed, so some issues may be missing.`,
        ]
      : [];
  const note = coverageNote(result);
  lines.push(
    ...totals(
      result.findings,
      {
        accepted: result.accepted.length,
        warned: result.warnings.length,
        failed: failed > 0,
        duration: `${result.durationMs} ms`,
        nothing: note?.nothing ?? false,
        note: note?.text
          ? wrap(note.text, textWidthAfter(2, width)).map((l) => c.dim(`  ${l}`))
          : [],
      },
      c,
      paint,
      details,
    ),
  );
  return lines;
}

interface Totals {
  accepted: number;
  warned: number;
  /** A check failed, so "No issues found" isn't shown as a pass. */
  failed: boolean;
  duration?: string;
  /** Nothing was found to read: say "Nothing to scan" rather than "No issues found". */
  nothing?: boolean;
  /** Dim lines shown under the counts. */
  note?: string[];
}

/** The issue counts by severity, or "No issues found", then the --details hint. */
function totals(
  findings: readonly Finding[],
  t: Totals,
  c: Colors,
  paint: Record<Severity, Paint>,
  details: boolean,
): string[] {
  const extra = [
    t.accepted > 0 ? c.dim(`· ${count(t.accepted)} accepted`) : '',
    t.warned > 0 ? c.yellow(`· ${plural(t.warned, 'warning')}`) : '',
    t.duration ? c.dim(`· ${t.duration}`) : '',
  ]
    .filter(Boolean)
    .map((part) => `  ${part}`)
    .join('');
  const note = t.note ?? [];
  const counts = summarize(findings);
  if (counts.total === 0) {
    // An empty folder isn't a clean one: say so, rather than "No issues found".
    const line =
      t.nothing && t.accepted === 0
        ? `  ${c.dim(DOT)} Nothing to scan${extra}`
        : `  ${t.failed ? c.dim(DOT) : c.green(DOT)} No issues found${extra}`;
    return [line, ...note];
  }
  const bySeverity = SEVERITIES.filter((s) => counts[s] > 0).map((s) =>
    paint[s](`${counts[s]} ${s}`),
  );
  const lines = [
    `  ${c.bold(plural(counts.total, 'issue'))}  ${bySeverity.join('  ')}${extra}`,
    ...note,
  ];
  if (!details) lines.push(c.dim('  Add --details to see why each one matters and how to fix it.'));
  return lines;
}

/**
 * "Scanned 42 projects, 3 with findings, 2 folders couldn't be opened", then the issue counts
 * across every project.
 */
function summaryAll(
  all: ScanAllResult,
  c: Colors,
  paint: Record<Severity, Paint>,
  details: boolean,
  width: number | undefined,
): string[] {
  const results = all.projects.map((project) => project.result);
  const searched = c.dim(
    `  · ${plural(all.foldersSearched, 'folder')} searched  · ${formatDuration(all.durationMs)}`,
  );
  const unreadable =
    all.unreadable.length > 0
      ? `, ${plural(all.unreadable.length, 'folder')} couldn't be opened`
      : '';

  if (results.length === 0) {
    return [
      `  ${c.dim(DOT)} No projects found${unreadable}${searched}`,
      ...wrap(
        `devsweep looks for folders that contain ${list(PROJECT_MARKERS, 'or')}, and found none here.`,
        textWidthAfter(2, width),
      ).map((l) => c.dim(`  ${l}`)),
    ];
  }

  const lines: string[] = [];
  const failed = results.filter((r) => r.errors.length > 0).length;
  if (failed > 0) {
    lines.push(
      `  ${c.red('×')} ${c.bold('Scan incomplete:')} ${plural(failed, 'project')} had a check fail or a broken config file, so some issues may be missing.`,
    );
  }
  const withFindings = results.filter((r) => r.findings.length > 0).length;
  lines.push(
    `  ${c.bold(`Scanned ${plural(results.length, 'project')}`)}, ${withFindings === 0 ? 'none' : withFindings} with findings${unreadable}${searched}`,
  );

  lines.push(
    ...totals(
      results.flatMap((r) => r.findings),
      {
        accepted: results.reduce((sum, r) => sum + r.accepted.length, 0),
        warned: results.reduce((sum, r) => sum + r.warnings.length, 0),
        failed: failed > 0,
      },
      c,
      paint,
      details,
    ),
  );
  return lines;
}

/** "840 ms", "4.2 s". */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
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
