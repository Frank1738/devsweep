import { describe, expect, it } from 'vitest';
import { field, JsoncParseError, type JsonValue, parseJsonc } from '../../src/checks/code/jsonc.js';
import { dedent } from '../helpers.js';

/** The plain JavaScript value, without positions, to compare with what JSON.parse would give. */
function plain(value: JsonValue): unknown {
  switch (value.kind) {
    case 'object':
      return Object.fromEntries(value.entries.map((e) => [e.key, plain(e.value)]));
    case 'array':
      return value.items.map(plain);
    default:
      return value.value;
  }
}

describe('parseJsonc', () => {
  it('reads plain JSON the same way JSON.parse does', () => {
    const text = '{"a": [1, -2.5e3, true, false, null], "b": {"c": "d\\n\\u00e9\\"\\\\"}}';
    expect(plain(parseJsonc(text))).toEqual(JSON.parse(text));
  });

  it('skips line and block comments, and allows trailing commas', () => {
    const value = parseJsonc(
      dedent(`
        // A comment before everything
        {
          /* a block
             comment */
          "tasks": [
            "one", // after a value
            "two",
          ],
        }
      `),
    );
    expect(plain(value)).toEqual({ tasks: ['one', 'two'] });
  });

  it('keeps // and /* inside strings, such as URLs', () => {
    const value = parseJsonc('{"url": "https://example.com/a//b", "glob": "src/*/x"} // done');
    expect(plain(value)).toEqual({ url: 'https://example.com/a//b', glob: 'src/*/x' });
  });

  it('gives the 1-based line and column of keys and values', () => {
    const value = parseJsonc(
      dedent(`
        {
          /* line 2
             line 3 */
          "outer": {
            "inner": "x"
          }
        }
      `),
    );
    const outer = field(value, 'outer');
    expect(outer?.keyAt).toEqual({ line: 4, column: 3 });
    expect(outer?.value).toMatchObject({ line: 4, column: 12 });
    expect(field(outer?.value, 'inner')?.keyAt).toEqual({ line: 5, column: 5 });
  });

  it('counts Windows line endings and a byte order mark correctly', () => {
    const value = parseJsonc('﻿{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n');
    expect(field(value, 'b')?.keyAt).toEqual({ line: 3, column: 3 });
  });

  it('uses the last value when a key repeats, like VS Code', () => {
    expect(field(parseJsonc('{"a": 1, "a": 2}'), 'a')?.value).toMatchObject({ value: 2 });
  });

  it.each([
    ['an unclosed object', '{"a": 1', /end of file|Expected "}"/],
    ['a missing comma', '{"a": 1 "b": 2}', /Expected "}" at line 1, column 9/],
    ['single quotes', "{'a': 1}", /property name/],
    ['two commas in a row', '[1,,2]', /Expected a value/],
    ['an unclosed block comment', '{} /* never closed', /Unterminated \/\* comment/],
    ['an unterminated string', '{"a": "b}', /Unterminated string/],
    ['a line break in a string', '{"a": "b\nc"}', /Line break inside a string/],
    ['a bad escape', '{"a": "\\q"}', /Invalid escape/],
    ['text after the end', '{} {}', /after the end/],
    ['an empty file', '', /end of file/],
  ])('rejects %s', (_, text, message) => {
    expect(() => parseJsonc(text)).toThrow(JsoncParseError);
    expect(() => parseJsonc(text)).toThrow(message);
  });

  it('refuses very deep nesting instead of overflowing the stack', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    expect(() => parseJsonc(deep)).toThrow(/Nested too deeply/);
  });
});
