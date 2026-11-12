// Imports nothing from the rest of src, so any module can use it without a circular import.

/**
 * Orders text by character code, so "B" comes before "a". Unlike localeCompare, the result
 * doesn't depend on the language settings of the machine.
 */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
