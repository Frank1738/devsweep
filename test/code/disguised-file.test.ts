import { describe, expect, it } from 'vitest';
import {
  analyze,
  type FileHead,
  isCandidate,
  namesFile,
} from '../../src/checks/code/disguised-file.js';
import { CANARY, PAYLOAD } from './samples.js';

function head(content: Buffer | string): FileHead {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return { bytes, size: bytes.length };
}

/** Some bytes of a real-looking font after its signature: mostly zeros and binary values. */
const FONT_BODY = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x80, 0xff, 0x03]);
/** Binary data that isn't any font. */
const NOT_A_FONT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xfe]);

describe('isCandidate', () => {
  it('picks font extensions and font-like fake names, in any case', () => {
    for (const file of [
      'public/fonts/fa-solid-400.woff2',
      'a.woff',
      'a.TTF',
      'a.otf',
      'a.eot',
      'fonts/fa-solid-300.llf',
      'fa-solid.lkf',
      'FA-REGULAR-400.LLF',
    ]) {
      expect(isCandidate(file)).toBe(true);
    }
    for (const file of ['a.js', 'woff2', 'notes.llf', 'fa-solid-400.js', 'a.woff2.js']) {
      expect(isCandidate(file)).toBe(false);
    }
  });
});

describe('analyze', () => {
  it('reports a text file named like a font, at line 1, as critical', () => {
    const text = `(function(){${PAYLOAD}})();`;
    expect(analyze('public/fonts/fa-solid-400.woff2', head(text), undefined)).toEqual([
      expect.objectContaining({
        ruleId: 'code/disguised-file',
        severity: 'critical',
        file: 'public/fonts/fa-solid-400.woff2',
        line: 1,
        message:
          "Named like a WOFF2 font, but it doesn't start with the signature of any font format. " +
          'It is mostly readable text, which is how PolinRider hides JavaScript in fake fonts.',
      }),
    ]);
  });

  it('reports binary data that is not a font as high', () => {
    const [finding] = analyze('a.ttf', head(NOT_A_FONT), undefined);
    expect(finding?.severity).toBe('high');
    expect(finding?.message).toBe(
      "Named like a TrueType font, but it doesn't start with the signature of any font format.",
    );
  });

  it('is critical when a tasks.json or package.json command names the file, even if binary', () => {
    const [finding] = analyze('a.ttf', head(NOT_A_FONT), '.vscode/tasks.json');
    expect(finding?.severity).toBe('critical');
    expect(finding?.message).toContain('A command in .vscode/tasks.json names it.');
  });

  it.each([
    ['WOFF2', 'a.woff2', Buffer.concat([Buffer.from('wOF2'), FONT_BODY])],
    ['WOFF', 'a.woff', Buffer.concat([Buffer.from('wOFF'), FONT_BODY])],
    ['TrueType', 'a.ttf', FONT_BODY],
    ['TrueType (Apple)', 'a.ttf', Buffer.concat([Buffer.from('true'), FONT_BODY])],
    ['OpenType', 'a.otf', Buffer.concat([Buffer.from('OTTO'), FONT_BODY])],
    ['a collection', 'a.ttf', Buffer.concat([Buffer.from('ttcf'), FONT_BODY])],
    ['OpenType with a .ttf name', 'a.ttf', Buffer.concat([Buffer.from('OTTO'), FONT_BODY])],
  ])('accepts a real %s font', (_name, file, bytes) => {
    expect(analyze(file, head(bytes), undefined)).toEqual([]);
  });

  it('accepts a real EOT font, whose signature is at byte 34', () => {
    const eot = Buffer.alloc(80, 0x01);
    eot[34] = 0x4c;
    eot[35] = 0x50;
    expect(analyze('a.eot', head(eot), undefined)).toEqual([]);
    expect(analyze('a.eot', head(Buffer.alloc(80, 0x01)), undefined)).toHaveLength(1);
  });

  it('skips empty files', () => {
    expect(analyze('a.woff2', head(''), undefined)).toEqual([]);
  });

  it('skips Git LFS pointer files', () => {
    const pointer =
      'version https://git-lfs.github.com/spec/v1\n' +
      'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n' +
      'size 12345\n';
    expect(analyze('fonts/a.woff2', head(pointer), undefined)).toEqual([]);
  });

  it('reports font-like names no font uses, whatever is inside', () => {
    const [finding] = analyze('fonts/fa-solid-300.llf', head(NOT_A_FONT), undefined);
    expect(finding).toMatchObject({ severity: 'high', line: 1 });
    expect(finding?.message).toBe(
      'Named like a Font Awesome font, but ".llf" isn\'t a font format. PolinRider names its ' +
        'fake fonts like this.',
    );
    expect(analyze('fa-solid.lkf', head(PAYLOAD), undefined)[0]?.severity).toBe('critical');
  });

  it('never quotes the file', () => {
    const [finding] = analyze('a.woff2', head(PAYLOAD), undefined);
    expect(JSON.stringify(finding)).not.toContain(CANARY);
  });
});

describe('namesFile', () => {
  it("matches the file's name anywhere in a command, ignoring case", () => {
    const commands = ['node ./public/fonts/icons-400.woff2'];
    expect(namesFile(commands, 'public/fonts/ICONS-400.woff2')).toBe(true);
    expect(namesFile(commands, 'public/fonts/other.woff2')).toBe(false);
  });
});
