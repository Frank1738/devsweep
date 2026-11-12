import pc from 'picocolors';
import { CLEAR_LINE, hideCursor, sleep } from './terminal.js';

/** Width of the track the broom sweeps across, in columns. */
const TRACK = 24;
/** Length of the bright broom head. */
const HEAD = 3;
/** Columns used before the label: indent, "devsweep", gaps and the track. */
const PREFIX = 2 + 'devsweep'.length + 2 + TRACK + 2;

export interface SweepOptions {
  write(text: string): void;
  /** Shown after the track, e.g. the folder being scanned. */
  label: string;
  color: boolean;
  /** Terminal width; the label is shortened so the animation stays on one line. */
  width?: number | undefined;
  /** Duration of one pass across the track. At least one full pass is always shown. */
  passMs?: number | undefined;
  frameMs?: number | undefined;
}

/**
 * Animates a broom sweeping dust off a line while work runs:
 *
 *   devsweep  ━━━━━━━━━━━━━━━━━╸······  ../frontend
 *
 * Returns `stop`, which lets the current pass finish, shows the clean line for a moment,
 * then clears it and restores the cursor.
 */
export function startSweep(options: SweepOptions): () => Promise<void> {
  const c = pc.createColors(options.color);
  const passMs = options.passMs ?? 400;
  const started = Date.now();
  const label = shorten(options.label, options.width);

  const draw = (progress: number) => {
    const head = Math.round(progress * (TRACK + HEAD));
    let track = '';
    for (let i = 0; i < TRACK; i++) {
      if (i < head - HEAD) track += c.cyan('━');
      else if (i < head) track += c.bold(c.white(i === head - 1 ? '╸' : '━'));
      else track += c.dim('·');
    }
    options.write(`${CLEAR_LINE}  ${c.bold(c.cyan('devsweep'))}  ${track}  ${c.dim(label)}`);
  };

  const restoreCursor = hideCursor(options.write);
  const tick = () => draw(((Date.now() - started) % passMs) / passMs);
  draw(0);
  const timer = setInterval(tick, options.frameMs ?? 16);

  return async () => {
    await sleep(passMs - ((Date.now() - started) % passMs));
    clearInterval(timer);
    draw(1);
    await sleep(Math.min(120, passMs));
    options.write(CLEAR_LINE);
    restoreCursor();
  };
}

function shorten(label: string, width: number | undefined): string {
  if (width === undefined) return label;
  const room = width - PREFIX - 1;
  if (room < 4) return '';
  return label.length > room ? `…${label.slice(label.length - room + 1)}` : label;
}
