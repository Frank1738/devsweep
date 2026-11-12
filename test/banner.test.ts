import { stripVTControlCharacters as plain } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ART,
  BANNER_MIN_WIDTH,
  bannerFits,
  CANVAS_HEIGHT,
  playBanner,
  renderBanner,
  STAR_CHARS,
} from '../src/ui/banner.js';

const STARS = new RegExp(`[${STAR_CHARS.map((c) => `\\${c}`).join('')}]`, 'g');
/** Rows of the canvas that hold the word, with two rows of sky above. */
const WORD_ROWS = [2, 3, 4, 5, 6, 7];

function render(color: boolean, width = 100): string[] {
  return renderBanner({ color, version: '1.2.3', width });
}

describe('banner', () => {
  it('spells DEVSWEEP in six rows of equal width', () => {
    expect(ART).toHaveLength(6);
    expect(new Set(ART.map((row) => row.length))).toEqual(new Set([67]));
    expect(ART[0]).toBe('██████╗ ███████╗██╗   ██╗███████╗██╗    ██╗███████╗███████╗██████╗ ');
  });

  it('draws the word inside a canvas of sky, then a tagline with the version', () => {
    const lines = render(false);
    expect(lines).toHaveLength(CANVAS_HEIGHT + 1);
    expect(WORD_ROWS.map((row) => lines[row])).toEqual(ART.map((row) => `  ${row}`.trimEnd()));
    expect(lines.at(-1)).toBe('  supply-chain & credential risk scanner · v1.2.3');
  });

  it('fills the sky with stars when color is on, and leaves it empty when off', () => {
    const starsIn = (lines: string[]) => lines.slice(0, -1).map(plain).join('').match(STARS) ?? [];
    expect(starsIn(render(true)).length).toBeGreaterThan(20);
    expect(starsIn(render(false))).toEqual([]);
  });

  it('keeps stars out of the word and the column beside it, so it stays crisp', () => {
    const lines = render(true).map(plain);
    const wordAndMargin = 2 + 67 + 1;
    for (const row of WORD_ROWS) {
      expect(lines[row]?.slice(0, wordAndMargin).match(STARS)).toBeNull();
    }
  });

  it('draws the same sky on every run', () => {
    expect(render(true)).toEqual(render(true));
  });

  it('crops the sky to fit narrow terminals', () => {
    const lines = render(true, BANNER_MIN_WIDTH).map(plain);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(BANNER_MIN_WIDTH);
  });

  it('shades the letters in grays, lighter at the top left', () => {
    const lines = render(true);
    const top = lines[WORD_ROWS[0] ?? 0] ?? '';
    const bottom = lines[WORD_ROWS[4] ?? 0] ?? '';
    expect(top.startsWith('  \u001b[0;38;5;255m█')).toBe(true);
    expect(bottom).toMatch(/38;5;24[4-9]m█/);
    expect(lines.join('')).toMatch(/38;5;2(3[7-9]|4[01])m[╗║╝╚═╔]/);
  });

  it('only fits terminals wide enough for the whole word', () => {
    expect(bannerFits(undefined)).toBe(false);
    expect(bannerFits(BANNER_MIN_WIDTH - 1)).toBe(false);
    expect(bannerFits(BANNER_MIN_WIDTH)).toBe(true);
  });

  it('sweeps the word in over the sky, then restores the cursor', async () => {
    const writes: string[] = [];
    await playBanner((text) => writes.push(text), {
      color: true,
      version: '1',
      width: 100,
      durationMs: 60,
      frameMs: 5,
    });
    // Every frame redraws the whole canvas; every frame after the first moves back up first.
    const frames = writes.filter((w) => w.includes('\u001b[2K'));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.slice(1).every((frame) => frame.startsWith(`\u001b[${CANVAS_HEIGHT}A`))).toBe(
      true,
    );
    const blocks = (frame: string) => (plain(frame).match(/█/g) ?? []).length;
    expect(blocks(frames[0] ?? '')).toBeLessThan(blocks(frames.at(-1) ?? ''));
    expect(blocks(frames.at(-1) ?? '')).toBe(ART.join('').match(/█/g)?.length);
    expect(writes[0]).toBe('\u001b[?25l');
    expect(writes.at(-1)).toBe('\u001b[?25h');
  });
});
