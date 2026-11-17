import pc from 'picocolors';
import { CLEAR_LINE, fitWidth, hideCursor, printable } from './terminal.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Columns used before the text: indent, spinner, "devsweep" and gaps. */
const PREFIX = 2 + 1 + 1 + 'devsweep'.length + 2;

export interface ProgressOptions {
  write(text: string): void;
  /** The text to show. Called only when the line redraws, at most once a frame. */
  text: () => string;
  color: boolean;
  /** Terminal width; the text is shortened so the line never wraps. */
  width?: number | undefined;
  /** Least time between redraws. Searching a drive reports thousands of folders a second. */
  frameMs?: number | undefined;
}

export interface Progress {
  /** Says the text has changed. Redraws at most once a frame. */
  update(): void;
  /** Clears the line and restores the cursor. */
  stop(): void;
}

/**
 * One line that rewrites itself in place while a long job runs:
 *
 *   ⠹ devsweep  searching  12,345 folders · 42 projects found
 *
 * Only for an interactive terminal. In CI or a pipe, the redraws would pile up as separate lines.
 */
export function startProgress(options: ProgressOptions): Progress {
  const c = pc.createColors(options.color);
  const frameMs = options.frameMs ?? 80;
  const started = Date.now();
  let drawnAt = 0;

  const draw = () => {
    drawnAt = Date.now();
    const frame = SPINNER[Math.floor((Date.now() - started) / frameMs) % SPINNER.length];
    options.write(
      `${CLEAR_LINE}  ${c.cyan(frame ?? '')} ${c.bold(c.cyan('devsweep'))}  ${c.dim(fitWidth(printable(options.text(), true), options.width, PREFIX, 'start'))}`,
    );
  };

  const restoreCursor = hideCursor(options.write);
  draw();
  // The timer keeps the spinner turning even when nothing new has been reported.
  const timer = setInterval(draw, frameMs);

  return {
    update() {
      if (Date.now() - drawnAt >= frameMs) draw();
    },
    stop() {
      clearInterval(timer);
      options.write(CLEAR_LINE);
      restoreCursor();
    },
  };
}
