// Small helpers shared by the rules that read every file.

/** The 1-based line and column of an offset in `text`. Counts line breaks once, with indexOf. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (
    let next = text.indexOf('\n');
    next !== -1 && next < offset;
    next = text.indexOf('\n', next + 1)
  ) {
    line++;
    lineStart = next + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** Calls `visit` with each line of `text` and its 1-based number, without the line break. */
export function forEachLine(text: string, visit: (line: string, number: number) => void): void {
  let start = 0;
  let number = 1;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const stop = end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
    visit(text.slice(start, stop), number);
    if (end === text.length) return;
    start = end + 1;
    number++;
  }
}

/** The last part of a path with forward slashes. */
export function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** The file's extension in lower case, without the dot, or '' when it has none. */
export function extensionOf(file: string): string {
  const name = baseName(file);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** True for characters that can be part of a JavaScript name: letters, digits, _ and $. */
export function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24 ||
    code > 0x7f
  );
}
