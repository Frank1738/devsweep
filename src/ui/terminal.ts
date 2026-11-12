/** Terminal escape sequences and helpers shared by the animations. */

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
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

/**
 * Control characters other than tab. A terminal reads some of them as commands: ESC starts
 * sequences that move the cursor or erase lines, and CR jumps back to the start of the line so
 * the next text covers what was there.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/**
 * Makes text from a scanned repository or from GitHub safe to print. A file name or file could
 * hold escape sequences that erase or fake lines of the report, so each control character is
 * shown as an escape like \x1b instead. Newlines are kept unless `oneLine` is set.
 */
export function printable(text: string, oneLine = false): string {
  return text.replace(CONTROL, (char) =>
    char === '\n' && !oneLine ? char : `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
