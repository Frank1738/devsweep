import { CLEAR_LINE, cursorUp, hideCursor, sleep } from './terminal.js';

/** Block letters in the "ANSI Shadow" style. The box-drawing strokes form the shadow. */
const LETTERS: Record<string, readonly string[]> = {
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  V: ['██╗   ██╗', '██║   ██║', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚═══╝  '],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
};

/** "DEVSWEEP", six rows of equal width. */
export const ART: readonly string[] = [0, 1, 2, 3, 4, 5].map((row) =>
  [...'DEVSWEEP'].map((letter) => LETTERS[letter]?.[row] ?? '').join(''),
);
const ART_WIDTH = ART[0]?.length ?? 0;

const INDENT = 2;
/** Open sky around the word, for the starfield. */
const SKY_ABOVE = 2;
const SKY_BELOW = 1;
export const CANVAS_HEIGHT = SKY_ABOVE + ART.length + SKY_BELOW;
/** Full canvas width: the word plus open sky to its right. Narrower terminals crop the sky. */
const CANVAS_WIDTH = INDENT + ART_WIDTH + 16;
/** Narrowest terminal the banner is drawn in. */
export const BANNER_MIN_WIDTH = INDENT + ART_WIDTH + 3;

/** Characters used for stars, so tests can tell sky from lettering. */
export const STAR_CHARS = ['.', '·'] as const;

export interface BannerOptions {
  color: boolean;
  version: string;
  /** Terminal width. The sky is cropped to fit. */
  width?: number | undefined;
}

export function bannerFits(width: number | undefined): boolean {
  return width !== undefined && width >= BANNER_MIN_WIDTH;
}

/** The finished banner: the word over a starfield, then a tagline. */
export function renderBanner(options: BannerOptions): string[] {
  return [...canvas(ART_WIDTH, undefined, options), tagline(options)];
}

/**
 * Draws the starfield, then sweeps the word in over it from left to right, led by a bright
 * edge, while the stars twinkle. Leaves a blank line after the tagline.
 */
export async function playBanner(
  write: (text: string) => void,
  options: BannerOptions & { durationMs?: number; frameMs?: number },
): Promise<void> {
  // Progress comes from the clock, not a frame count: Windows timers tick every ~15.6 ms,
  // so counting frames would make the animation run up to twice as long there.
  const durationMs = options.durationMs ?? 320;
  const started = Date.now();
  const restoreCursor = hideCursor(write);
  write('\n');
  for (let first = true; ; first = false) {
    const elapsed = Date.now() - started;
    const progress = Math.min(1, elapsed / durationMs);
    const rows = canvas(
      Math.round(progress * ART_WIDTH),
      progress < 1 ? elapsed : undefined,
      options,
    );
    const redraw = first ? '' : cursorUp(CANVAS_HEIGHT);
    write(`${redraw}${rows.map((row) => `${CLEAR_LINE}${row}\n`).join('')}`);
    if (progress >= 1) break;
    await sleep(options.frameMs ?? 16);
  }
  write(`${tagline(options)}\n\n`);
  restoreCursor();
}

// --- Drawing -------------------------------------------------------------------------------

interface Cell {
  char: string;
  /** SGR parameters, e.g. "38;5;250". Empty for no styling. */
  style: string;
}

/**
 * The canvas with the word's first `revealed` columns drawn. `time` drives the twinkle; leave
 * it undefined for a still image.
 */
function canvas(revealed: number, time: number | undefined, options: BannerOptions): string[] {
  const width = Math.min(CANVAS_WIDTH, (options.width ?? CANVAS_WIDTH) - 1);
  const rows: string[] = [];
  for (let row = 0; row < CANVAS_HEIGHT; row++) {
    const cells: Cell[] = [];
    for (let col = 0; col < width; col++) {
      const letter = artChar(row, col);
      const artCol = col - INDENT;
      if (letter !== ' ') {
        cells.push(
          artCol < revealed ? letterCell(letter, row - SKY_ABOVE, artCol, revealed) : BLANK,
        );
      } else {
        const star = options.color ? STARS.get(key(row, col)) : undefined;
        cells.push(star ? starCell(star, time) : BLANK);
      }
    }
    rows.push(join(cells, options.color));
  }
  return rows;
}

const BLANK: Cell = { char: ' ', style: '' };

function artChar(row: number, col: number): string {
  const artRow = row - SKY_ABOVE;
  const artCol = col - INDENT;
  if (artRow < 0 || artRow >= ART.length || artCol < 0 || artCol >= ART_WIDTH) return ' ';
  return ART[artRow]?.[artCol] ?? ' ';
}

/**
 * A gray gradient lit from the top left: solid strokes run from near white to mid gray, and the
 * box-drawing shadow strokes from dark gray to darker.
 */
function letterCell(char: string, artRow: number, artCol: number, revealed: number): Cell {
  // The last few columns drawn so far glow, like light catching the broom.
  if (revealed < ART_WIDTH && artCol >= revealed - 3) return { char, style: '1;38;5;255' };
  const light = (artRow / (ART.length - 1)) * 0.55 + (artCol / (ART_WIDTH - 1)) * 0.45;
  const shade = char === '█' ? 255 - Math.round(light * 11) : 241 - Math.round(light * 4);
  return { char, style: `38;5;${shade}` };
}

/** Joins cells into a line, emitting a style code only when the style changes. */
function join(cells: Cell[], color: boolean): string {
  let end = cells.length;
  while (end > 0 && cells[end - 1]?.char === ' ') end--;
  let line = '';
  let current = '';
  for (const cell of cells.slice(0, end)) {
    // Spaces look the same in any style, so they don't force a change.
    if (color && cell.char !== ' ' && cell.style !== current) {
      line += `\u001b[0${cell.style ? `;${cell.style}` : ''}m`;
      current = cell.style;
    }
    line += cell.char;
  }
  return current ? `${line}\u001b[0m` : line;
}

// --- The starfield -------------------------------------------------------------------------

interface Star {
  char: string;
  /** 256-color code. Grays (232-255) twinkle; the rare tinted stars don't. */
  shade: number;
  /** Where in its twinkle cycle the star starts, 0-1. */
  phase: number;
}

/**
 * Stars are scattered with a fixed seed, so the sky is the same on every run. They're denser
 * along a diagonal band, like a galaxy's arm, and never sit right next to a letter, so the word
 * stays crisp.
 */
const STARS: ReadonlyMap<string, Star> = (() => {
  const random = mulberry32(0x5eed);
  const stars = new Map<string, Star>();
  for (let row = 0; row < CANVAS_HEIGHT; row++) {
    for (let col = 0; col < CANVAS_WIDTH; col++) {
      // Draw the same number of random values for every cell, so the layout is stable.
      const [place, kind, look, phase] = [random(), random(), random(), random()];
      // Keep the word clean: no stars between its first and last letter, or touching it.
      const artRow = row - SKY_ABOVE;
      const inWord =
        artRow >= 0 && artRow < ART.length && col >= INDENT - 1 && col <= INDENT + ART_WIDTH;
      // No clumps: never right next to another star.
      if (inWord || stars.has(key(row, col - 1))) continue;

      const armRow = (CANVAS_HEIGHT - 1) * (1 - col / (CANVAS_WIDTH - 1));
      const distance = row - armRow;
      const density = 0.06 + 0.2 * Math.exp(-(distance * distance) / 2);
      if (place >= density) continue;

      stars.set(key(row, col), starLook(kind, look, phase));
    }
  }
  return stars;
})();

/** Every star is a dot; depth comes from brightness, from faint gray to near white. */
function starLook(kind: number, look: number, phase: number): Star {
  const char = look < 0.5 ? '.' : '·';
  if (kind < 0.62) return { char, shade: 238 + Math.floor(look * 4), phase };
  if (kind < 0.88) return { char, shade: 245 + Math.floor(look * 4), phase };
  if (kind < 0.95) return { char: '·', shade: 253 + Math.floor(look * 3), phase };
  // A few faintly colored stars: pale blue and lavender.
  return { char: '·', shade: look < 0.5 ? 153 : 183, phase };
}

function starCell(star: Star, time: number | undefined): Cell {
  if (time === undefined || star.shade < 232)
    return { char: star.char, style: `38;5;${star.shade}` };
  const twinkle = Math.round(3 * Math.sin(star.phase * 2 * Math.PI + time / 70));
  const shade = Math.min(255, Math.max(236, star.shade + twinkle));
  return { char: star.char, style: `38;5;${shade}` };
}

function key(row: number, col: number): string {
  return `${row}:${col}`;
}

/** A small seeded random number generator, so the starfield never changes between runs. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tagline(options: BannerOptions): string {
  const text = `supply-chain & credential risk scanner · v${options.version}`;
  return `${' '.repeat(INDENT)}${options.color ? `\u001b[38;5;244m${text}\u001b[0m` : text}`;
}
