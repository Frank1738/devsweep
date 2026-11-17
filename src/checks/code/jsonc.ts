import type { Position } from '../../types.js';

/**
 * A small parser for JSONC, the "JSON with comments" that VS Code uses for tasks.json and
 * settings.json: JSON plus `//` and `/* *\/` comments and trailing commas. It keeps the line and
 * column of every value and key, so findings can point at the exact key.
 *
 * It reads the text one character at a time, so `//` inside a string (such as a URL) stays part
 * of the string. Stripping comments with a regex first would cut such strings in half.
 */

export type JsonValue = JsonObject | JsonArray | JsonString | JsonNumber | JsonLiteral;

export interface JsonObject extends Position {
  kind: 'object';
  /** Every entry in file order, including repeated keys. */
  entries: JsonEntry[];
}

export interface JsonEntry {
  key: string;
  /** Where the key's opening quote is. */
  keyAt: Position;
  value: JsonValue;
}

export interface JsonArray extends Position {
  kind: 'array';
  items: JsonValue[];
}

export interface JsonString extends Position {
  kind: 'string';
  value: string;
}

export interface JsonNumber extends Position {
  kind: 'number';
  value: number;
}

export interface JsonLiteral extends Position {
  kind: 'literal';
  value: boolean | null;
}

export class JsoncParseError extends Error {}

/** Deeper nesting than this is refused, so a hostile file can't overflow the stack. */
const MAX_DEPTH = 256;

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Throws JsoncParseError, with the line and column of the problem, for text that isn't JSONC. */
export function parseJsonc(text: string): JsonValue {
  return new Parser(text).document();
}

/**
 * The value of `key` in an object, or undefined. When a key repeats, the last one wins, as in
 * VS Code and JSON.parse.
 */
export function field(value: JsonValue | undefined, key: string): JsonEntry | undefined {
  if (value?.kind !== 'object') return undefined;
  for (let i = value.entries.length - 1; i >= 0; i--) {
    const entry = value.entries[i];
    if (entry?.key === key) return entry;
  }
  return undefined;
}

/** Every string inside a value, at any depth, in order. */
export function allStrings(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (value.kind === 'string') return [value.value];
  if (value.kind === 'array') return value.items.flatMap(allStrings);
  if (value.kind === 'object') return value.entries.flatMap((entry) => allStrings(entry.value));
  return [];
}

class Parser {
  private index = 0;
  private line = 1;
  /** Index of the first character of the current line. */
  private lineStart = 0;

  constructor(private readonly text: string) {
    // A byte order mark at the start isn't part of the JSON.
    if (text.startsWith('﻿')) {
      this.index = 1;
      this.lineStart = 1;
    }
  }

  document(): JsonValue {
    this.skipBlank();
    const value = this.value(0);
    this.skipBlank();
    if (this.index < this.text.length) this.fail('Unexpected text after the end of the JSON');
    return value;
  }

  private value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail('Nested too deeply');
    const at = this.position();
    const char = this.text[this.index];
    if (char === '{') return this.object(at, depth);
    if (char === '[') return this.array(at, depth);
    if (char === '"') return { kind: 'string', value: this.string(), ...at };
    for (const [word, literal] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(word, this.index)) {
        this.index += word.length;
        return { kind: 'literal', value: literal, ...at };
      }
    }
    NUMBER.lastIndex = this.index;
    const number = NUMBER.exec(this.text);
    if (number) {
      this.index += number[0].length;
      return { kind: 'number', value: Number(number[0]), ...at };
    }
    return this.unexpected('a value');
  }

  private object(at: Position, depth: number): JsonObject {
    this.index++; // {
    const entries: JsonEntry[] = [];
    this.skipBlank();
    while (this.text[this.index] !== '}') {
      if (this.text[this.index] !== '"') this.unexpected('a property name in double quotes');
      const keyAt = this.position();
      const key = this.string();
      this.skipBlank();
      this.expect(':');
      this.skipBlank();
      entries.push({ key, keyAt, value: this.value(depth + 1) });
      if (!this.comma()) break;
    }
    this.expect('}');
    return { kind: 'object', entries, ...at };
  }

  private array(at: Position, depth: number): JsonArray {
    this.index++; // [
    const items: JsonValue[] = [];
    this.skipBlank();
    while (this.text[this.index] !== ']') {
      items.push(this.value(depth + 1));
      if (!this.comma()) break;
    }
    this.expect(']');
    return { kind: 'array', items, ...at };
  }

  /**
   * After an item: skips a comma and the blanks after it. Returns false when there is no comma,
   * so the list must end there. A comma right before the closing bracket is the trailing comma
   * JSONC allows: the caller's loop sees the bracket and stops.
   */
  private comma(): boolean {
    this.skipBlank();
    if (this.text[this.index] !== ',') return false;
    this.index++;
    this.skipBlank();
    return true;
  }

  private string(): string {
    this.index++; // opening quote
    let result = '';
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) this.fail('Unterminated string');
      if (char === '"') break;
      if (char === '\n' || char === '\r') this.fail('Line break inside a string');
      if (char === '\\') {
        const next = this.text[this.index + 1];
        if (next === 'u') {
          const hex = this.text.slice(this.index + 2, this.index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 6;
          continue;
        }
        const decoded = next === undefined ? undefined : ESCAPES[next];
        if (decoded === undefined) this.fail('Invalid escape in a string');
        result += decoded;
        this.index += 2;
        continue;
      }
      result += char;
      this.index++;
    }
    this.index++; // closing quote
    return result;
  }

  /** Skips spaces, line breaks and comments. */
  private skipBlank(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === '\n') {
        this.newLine(this.index + 1);
      } else if (char === ' ' || char === '\t' || char === '\r') {
        this.index++;
      } else if (char === '/' && this.text[this.index + 1] === '/') {
        const end = this.text.indexOf('\n', this.index);
        this.index = end === -1 ? this.text.length : end;
      } else if (char === '/' && this.text[this.index + 1] === '*') {
        const end = this.text.indexOf('*/', this.index + 2);
        if (end === -1) this.fail('Unterminated /* comment');
        for (let i = this.index; i < end; i++) if (this.text[i] === '\n') this.newLine(i + 1);
        this.index = end + 2;
      } else {
        return;
      }
    }
  }

  private newLine(start: number): void {
    this.line++;
    this.lineStart = start;
    this.index = start;
  }

  private expect(char: string): void {
    if (this.text[this.index] !== char) this.unexpected(`"${char}"`);
    this.index++;
  }

  private position(): Position {
    return { line: this.line, column: this.index - this.lineStart + 1 };
  }

  /** Fails with "Expected …", or "Unexpected end of file" when the text ran out. */
  private unexpected(expected: string): never {
    return this.fail(
      this.index >= this.text.length ? 'Unexpected end of file' : `Expected ${expected}`,
    );
  }

  private fail(message: string): never {
    const { line, column } = this.position();
    throw new JsoncParseError(`${message} at line ${line}, column ${column}`);
  }
}
