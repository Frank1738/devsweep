/** Terminal escape sequences and helpers shared by the animations. */

export const HIDE_CURSOR = '\u001b[?25l';
export const SHOW_CURSOR = '\u001b[?25h';
/** Returns to the start of the line and erases it. */
export const CLEAR_LINE = '\r\u001b[2K';

export function cursorUp(lines: number): string {
  return `\u001b[${lines}A`;
}

/**
 * Hides the cursor until the returned function is called. The cursor also comes back if the
 * process exits or the user presses Ctrl+C in the meantime.
 */
export function hideCursor(write: (text: string) => void): () => void {
  const show = () => write(SHOW_CURSOR);
  const onInterrupt = () => {
    write(`${CLEAR_LINE}${SHOW_CURSOR}`);
    process.exit(130);
  };
  process.once('exit', show);
  process.once('SIGINT', onInterrupt);
  write(HIDE_CURSOR);
  return () => {
    process.removeListener('exit', show);
    process.removeListener('SIGINT', onInterrupt);
    show();
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
