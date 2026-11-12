import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Returns a scanned file's lines, or undefined when the file can't be read. */
export type ReadLines = (file: string) => string[] | undefined;

/** Reads scanned files on demand, relative to the scan root, and remembers them. */
export function sourceReader(root: string): ReadLines {
  const cache = new Map<string, string[] | undefined>();
  return (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(path.join(root, file), 'utf8').split(/\r?\n/));
      } catch {
        cache.set(file, undefined);
      }
    }
    return cache.get(file);
  };
}

/**
 * The part of a source line that a finding points at, as 0-based offsets (`end` is exclusive):
 * from the finding's column, or the first non-blank character, to the end of the line's content.
 * The terminal underlines this span and SARIF highlights it, so both always agree.
 */
export function markedSpan(text: string, column?: number): { start: number; end: number } {
  const start = column !== undefined ? column - 1 : text.length - text.trimStart().length;
  return { start, end: text.trimEnd().length };
}
