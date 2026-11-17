// Number and list wording shared by findings, reports and progress lines.

/** 31302 → "31,302". The same on every machine, whatever its language settings. */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** "1 line", "3 lines". */
export function plural(n: number, word: string): string {
  return `${count(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** "a", "a and b", "a, b and c"; or "a, b or c". */
export function list(items: readonly string[], last: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`;
}
