import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPretty, wrap } from '../src/reporters/pretty.js';
import { scan } from '../src/scanner.js';
import type { Finding, ScanResult } from '../src/types.js';
import { fixture } from './helpers.js';

function result(findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult {
  return {
    root: '/repo',
    findings,
    accepted: [],
    warnings: [],
    errors: [],
    durationMs: 5,
    ...extra,
  };
}

const finding: Finding = {
  ruleId: 'workflow/unpinned-action',
  severity: 'high',
  message: 'Third-party action "example-org/deploy" is pinned to "v2".',
  subject: 'example-org/deploy@v2',
  file: '.github/workflows/ci.yml',
  line: 7,
  column: 15,
  remediation: 'Pin it to a full commit SHA.',
};

describe('formatPretty', () => {
  it('lists files with their most severe findings first', async () => {
    const scanned = await scan({ root: fixture('vulnerable-repo'), offline: true });
    const text = formatPretty(scanned, { target: 'repo', color: false });
    const files = text.split('\n').filter((line) => /^ {2}\.github/.test(line));
    expect(files.map((line) => line.trim())).toEqual([
      '.github/workflows/pr-preview.yml',
      '.github/workflows/release.yml',
      '.github/workflows/label.yml',
      '.github/workflows/docs.yml',
    ]);
  });

  it('aligns titles across groups, and omits trailing space when there is no subject', async () => {
    const scanned = await scan({ root: fixture('vulnerable-repo'), offline: true });
    const text = formatPretty(scanned, { target: 'repo', color: false });
    expect(text).toContain(
      '    ● low       16  Force push                            branch gh-pages\n',
    );
    expect(text).toContain('    ● medium     3  Uses the pull_request_target trigger\n');
  });

  it('shortens long subjects to fit the terminal', () => {
    const long = { ...finding, subject: `example-org/${'x'.repeat(200)}@v2` };
    const text = formatPretty(result([long]), { target: 'repo', color: false, width: 80 });
    const line = text.split('\n').find((l) => l.includes('Unpinned action')) ?? '';
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith('…')).toBe(true);
  });

  it('keeps every details line within the terminal width', async () => {
    const scanned = await scan({ root: fixture('vulnerable-repo'), offline: true });
    const text = formatPretty(scanned, {
      target: 'repo',
      color: false,
      details: true,
      width: 60,
      readLines: (file) =>
        readFileSync(path.join(fixture('vulnerable-repo'), file), 'utf8').split(/\r?\n/),
    });
    const tooLong = text.split('\n').filter((line) => line.length > 60);
    expect(tooLong).toEqual([]);
  });

  it('still wraps details at 20 columns on a terminal too narrow to fit them', () => {
    const text = formatPretty(result([finding]), {
      target: 'repo',
      color: false,
      details: true,
      width: 0,
    });
    expect(text).toContain(
      '      Third-party action\n      "example-org/deploy"\n      is pinned to "v2".\n',
    );
  });

  it('underlines the whole command when a finding has no column', () => {
    const noColumn: Finding = {
      ruleId: 'workflow/force-push',
      severity: 'high',
      message: 'Job "release" force-pushes.',
      file: '.github/workflows/ci.yml',
      line: 2,
    };
    const text = formatPretty(result([noColumn]), {
      target: 'repo',
      color: false,
      details: true,
      readLines: () => ['steps:', '  - run: git push --force'],
    });
    expect(text).toContain(
      '      2 │   - run: git push --force\n        │   ^^^^^^^^^^^^^^^^^^^^^^^\n',
    );
  });

  it('warns that results may be missing when a check failed', () => {
    const text = formatPretty(result([], { errors: [{ checkId: 'workflows', message: 'boom' }] }), {
      target: 'repo',
      color: false,
    });
    expect(text).toContain('  × check "workflows" failed: boom');
    expect(text).toContain('  × Scan incomplete: 1 check failed, so some issues may be missing.');
  });

  it('shows control characters from the scanned repository as escapes', () => {
    const ESC = '\u001b';
    const sneaky: Finding = {
      ...finding,
      file: `.github/workflows/ci${ESC}[2K.yml`,
      subject: `example-org/deploy@v2\r${ESC}[1A`,
      message: `Pinned to "v2".${ESC}[2J`,
    };
    const options = {
      target: 'repo',
      color: false,
      // Lines 6 and 7 of the file: the line above the finding, and the finding's own line.
      readLines: () => [
        ...Array.from({ length: 5 }, () => ''),
        `# ${ESC}[1A${ESC}[2K hidden`,
        '  - uses: x\u0007',
      ],
    };
    const scanned = result([sneaky], {
      warnings: [{ checkId: 'workflows', message: `Skipped${ESC}]0;title`, file: 'a\nb.yml' }],
    });
    for (const details of [false, true]) {
      const text = formatPretty(scanned, { ...options, details });
      // Color is off, so the report itself writes no control characters but newlines.
      expect([...text].filter((char) => char !== '\n' && char < ' ')).toEqual([]);
      expect(text).toContain('ci\\x1b[2K.yml');
      expect(text).toContain('a\\x0ab.yml');
    }
    expect(formatPretty(scanned, { ...options, details: true })).toContain(
      '# \\x1b[1A\\x1b[2K hidden',
    );
  });

  it('colors severities when color is on', () => {
    const text = formatPretty(result([finding]), { target: 'repo', color: true });
    expect(text).toContain('\u001b[31m● high');
  });
});

describe('wrap', () => {
  it('wraps on word boundaries', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('splits a word longer than the width across lines', () => {
    expect(wrap('a verylongword b', 5)).toEqual(['a', 'veryl', 'ongwo', 'rd b']);
  });

  it('treats a width below 1 as 1, instead of looping forever', () => {
    expect(wrap('hello world', 0)).toEqual(['h', 'e', 'l', 'l', 'o', 'w', 'o', 'r', 'l', 'd']);
    expect(wrap('ab', -3)).toEqual(['a', 'b']);
  });
});
