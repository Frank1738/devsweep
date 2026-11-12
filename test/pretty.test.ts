import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPretty, wrap } from '../src/reporters/pretty.js';
import { scan } from '../src/scanner.js';
import type { Finding, ScanResult } from '../src/types.js';
import { fixture } from './helpers.js';

function result(findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult {
  return { root: '/repo', findings, warnings: [], errors: [], durationMs: 5, ...extra };
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
    const scanned = await scan({ root: fixture('vulnerable-repo') });
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
    const scanned = await scan({ root: fixture('vulnerable-repo') });
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
    const scanned = await scan({ root: fixture('vulnerable-repo') });
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
});
