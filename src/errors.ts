// Imports nothing from the rest of src, so any module can use it without a circular import.

/** The message of a caught value. JavaScript can throw anything, not only Error objects. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a file system error means the path doesn't exist. */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
