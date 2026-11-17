import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, appliesTo } from '../../src/checks/code/known-marker.js';
import {
  FIXED_MARKERS,
  PATTERN_MARKERS,
  SOURCE_COMMIT,
  sourceOf,
} from '../../src/checks/code/markers.js';
import { CANARY, fixedMarkers, joined, markerOfKind, PAYLOAD, pad } from './samples.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('analyze', () => {
  it.each(fixedMarkers().map((m) => [m.line, m.kind, m.text] as const))(
    'finds the marker from strong.txt line %i (%s) at its line and column',
    (_line, kind, text) => {
      const source = `const ok = 1;\nconst a = 2; ${text} more();\n`;
      expect(analyze('src/app.js', source)).toEqual([
        expect.objectContaining({
          ruleId: 'code/known-marker',
          severity: 'critical',
          file: 'src/app.js',
          line: 2,
          column: 14,
          subject: kind,
        }),
      ]);
    },
  );

  it('says what kind of marker it found, and links to its source, without quoting it', () => {
    const marker = markerOfKind('obfuscator marker');
    const [finding] = analyze('a.js', `x;${marker};${PAYLOAD}`);
    expect(finding?.message).toBe(
      "Contains a known PolinRider obfuscator marker at column 3, a string from the campaign's " +
        "malware that normal code doesn't contain. Source: " +
        sourceOf('strong.txt', FIXED_MARKERS[0]?.line ?? 0),
    );
    expect(finding?.message).not.toContain(marker);
    expect(JSON.stringify(finding)).not.toContain(CANARY);
  });

  it('gives one finding per file, at the first marker, counting the others', () => {
    const obfuscator = markerOfKind('obfuscator marker');
    const key = markerOfKind('XOR key');
    const [finding, ...rest] = analyze('a.js', `a;\n${key}\n${obfuscator}\n${obfuscator}`);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ line: 2, column: 1, subject: 'XOR key' });
    expect(finding?.message).toContain('1 other known marker is in this file too.');
  });

  describe('patterns', () => {
    const fakeFontRun = (weight: string, prefix = 'node  ./public/fonts/') =>
      joined(prefix, 'fa-solid-', weight, '.woff2');

    it.each([
      ['node running a fake font, any weight', `"command": "${fakeFontRun('900')}"`, 13],
      ['the var z tag after padding', `x;${pad(70)}${joined('var z', " = '-12-3';")}`, 73],
      ['the var z tag after tabs', `x;${pad(266, '\t')}${joined('var z', " = '-7';")}`, 269],
      ['the global.i tag, single quotes', joined('a;', 'global.i', " = 'A11-x'"), 3],
      ['the global.i tag, double quotes', joined('a;', 'global.i', '="A9"'), 3],
    ])('finds %s', (_name, line, column) => {
      expect(analyze('a.js', line)).toEqual([
        expect.objectContaining({ line: 1, column, severity: 'critical' }),
      ]);
    });

    it.each([
      ['a script handed a font name', joined('node scripts/copy.js ', 'fa-solid-', '900.woff2')],
      ['a font weight without three digits', fakeFontRun('90')],
      ['a font path in quotes after node', joined('node "./', 'fa-solid-', '400.woff2"')],
      ['var z without padding, as in minified code', joined('x;var z', " = '-1';")],
      ['var z after 63 spaces', `x;${pad(63)}${joined('var z', " = '-1';")}`],
      ['var z without the closing quote', `x;${pad(70)}${joined('var z', " = '-1")}`],
      ['global.i set to a word', joined('global.i', " = 'Alpha'")],
      ['global.i with a three-digit number', joined('global.i', " = 'A123'")],
    ])('ignores %s', (_name, line) => {
      expect(analyze('a.js', line)).toEqual([]);
    });
  });

  it('reads a line megabytes long quickly, even full of near-matches', () => {
    const marker = markerOfKind('campaign tag');
    const long = `x;${'a'.repeat(5_000_000)}${marker}`;
    const decoys = [
      'fa-solid-'.repeat(300_000),
      joined('global', '.i').repeat(300_000),
      `${pad(70)}${joined('var z', " = '-")}`.repeat(50_000),
    ].join('');
    const started = performance.now();
    expect(analyze('a.js', long)[0]?.column).toBe(5_000_003);
    expect(analyze('a.js', decoys)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('reports nothing for a clean file', () => {
    expect(analyze('a.js', 'export const config = { global: true };\n')).toEqual([]);
  });
});

describe('appliesTo', () => {
  it('skips only Markdown files', () => {
    expect(appliesTo('docs/research.md')).toBe(false);
    expect(appliesTo('README.MD')).toBe(false);
    expect(appliesTo('notes.txt')).toBe(true);
    expect(appliesTo('public/fonts/a.woff2')).toBe(true);
  });
});

describe('the bundled marker list', () => {
  it('holds valid, distinct entries, none containing another', () => {
    const texts = fixedMarkers().map((m) => m.text);
    expect(texts.length).toBeGreaterThan(40);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) {
      expect(text.length).toBeGreaterThanOrEqual(6);
      expect(text).toBe(text.trim());
      expect(texts.filter((other) => other !== text && text.includes(other))).toEqual([]);
    }
  });

  it('links every entry to its line at a fixed commit', () => {
    expect(SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceOf('strong.txt', 5)).toBe(
      `https://github.com/meSingh/polinrider-scanner/blob/${SOURCE_COMMIT}/ioc/strong.txt#L5`,
    );
    for (const entry of [...FIXED_MARKERS, ...PATTERN_MARKERS]) {
      expect(entry.line).toBeGreaterThan(0);
    }
  });

  it("keeps meSingh's MIT copyright notice in the data file", async () => {
    const source = await readFile(path.join(REPO, 'src/checks/code/markers.ts'), 'utf8');
    expect(source).toContain('Copyright (c) 2026 Mandeep Singh');
    expect(source).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('does not make devsweep flag its own source', async () => {
    for (const file of [
      'src/checks/code/markers.ts',
      'src/checks/code/known-marker.ts',
      'test/code/known-marker.test.ts',
      'test/code/samples.ts',
    ]) {
      const source = await readFile(path.join(REPO, file), 'utf8');
      expect(analyze(file, source), file).toEqual([]);
    }
  });
});
