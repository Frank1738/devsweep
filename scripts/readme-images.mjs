// Draws the README's terminal pictures from devsweep's real output, so they always match it:
//
//   assets/demo.svg     a scan of test/fixtures/vulnerable-repo, animated: the command is typed,
//                       the banner sweeps in, and the results appear, with the real timing.
//   assets/details.svg  the first two findings of the same scan with --details.
//
// Run it with `node scripts/readme-images.mjs` after changing anything these pictures show.
//
// It runs devsweep's own CLI code with color and animation on, records everything written to the
// terminal, and replays that through a small terminal emulator. Block letters, box-drawing lines,
// dots and stars are drawn as shapes rather than font glyphs, so they look the same everywhere.
// GitHub shows README images with <img>, which allows CSS animation but no scripts or web fonts.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const FIXTURE = 'test/fixtures/vulnerable-repo';
const PROMPT = '\u001b[36m~/vulnerable-repo\u001b[0m \u001b[90m$\u001b[0m ';
const PROMPT_WIDTH = '~/vulnerable-repo $ '.length;
const COMMAND = 'npx @frank1738/devsweep --offline';
/** Wide enough that no finding is cut short. */
const DEMO_COLUMNS = 120;
const DETAILS_COLUMNS = 100;

// Timeline of the demo, in seconds. Everything after ENTER comes from the recording.
const TYPE_START = 0.6;
const TYPE_PER_CHAR = 0.045;
const ENTER = TYPE_START + COMMAND.length * TYPE_PER_CHAR + 0.45;

// --- Look -----------------------------------------------------------------------------------

const FONT_SIZE = 14;
const CELL_W = 8.4;
const CELL_H = 17;
const BASELINE = 12.5;
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const MARGIN = 18;
const TITLE_H = 34;
const PAD_X = 20;
const PAD_Y = 16;

const BG = '#0f1319';
const TITLE_BG = '#161b23';
const BORDER = '#2a313c';
const FG = '#c9d1d9';
const BASIC = {
  30: '#484f58',
  31: '#ff7b72',
  32: '#7ee787',
  33: '#e3b341',
  34: '#79c0ff',
  35: '#d2a8ff',
  36: '#56d4dd',
  37: '#f0f6fc',
  90: '#8b949e',
  91: '#ffa198',
  92: '#a5f0b0',
  93: '#f2cc60',
  94: '#a5d6ff',
  95: '#e2c5ff',
  96: '#87e8ef',
  97: '#ffffff',
};

// --- Main -----------------------------------------------------------------------------------

/** Called at the end of this file, once everything below is defined. */
async function run() {
  const cli = await loadCli();
  const demo = await record(cli, ['--offline'], { interactive: true, width: DEMO_COLUMNS });
  const details = await record(cli, ['--offline', '--details'], {
    interactive: false,
    width: DETAILS_COLUMNS,
  });
  await mkdir('assets', { recursive: true });
  await writeFile('assets/demo.svg', demoSvg(demo));
  await writeFile('assets/details.svg', detailsSvg(details));
  console.log('assets/demo.svg\nassets/details.svg');
}

/**
 * Bundles src/cli.ts on its own, so the pictures come from the current source. The bundle is a
 * temporary file in dist/ (ignored by git): src/version.ts reads ../package.json, so the bundle
 * has to sit one folder below the repository root.
 */
async function loadCli() {
  const file = path.join(root, 'dist', `.readme-images-${process.pid}.mjs`);
  try {
    await build({
      input: 'src/cli.ts',
      platform: 'node',
      logLevel: 'warn',
      output: { file, format: 'esm', codeSplitting: false },
    });
    return (await import(pathToFileURL(file).href)).main;
  } finally {
    await rm(file, { force: true });
  }
}

/** Runs the CLI in the fixture folder and keeps every write with its time in seconds. */
async function record(cli, args, { interactive, width }) {
  const writes = [];
  const started = performance.now();
  const write = (text) => writes.push({ time: (performance.now() - started) / 1000, text });
  process.chdir(FIXTURE);
  try {
    await cli(args, { stdout: write, stderr: write, color: true, interactive, width, env: {} });
  } finally {
    process.chdir(root);
  }
  return { writes, end: (performance.now() - started) / 1000 };
}

// --- Terminal emulator ----------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: reading escape sequences is the point.
const TOKEN = /\u001b\[([?\d;]*)([A-Za-z])|(\r|\n|[^\u001b\r\n]+)/g;
const SPACE = { ch: ' ', fg: undefined, bold: false, dim: false };

/** Just enough of a terminal for devsweep's output: text, colors, newlines and redraws. */
class Screen {
  rows = [];
  /** When each row last changed, in seconds. */
  changedAt = [];
  row = 0;
  col = 0;
  style = { fg: undefined, bold: false, dim: false };

  write(text, time = 0) {
    for (const [, params, command, plain] of text.matchAll(TOKEN)) {
      if (plain === '\n') {
        this.row++;
        this.col = 0;
      } else if (plain === '\r') {
        this.col = 0;
      } else if (plain !== undefined) {
        for (const ch of plain) this.put(ch, time);
      } else if (command === 'm') {
        this.sgr(params);
      } else if (command === 'K') {
        this.rows[this.row] = [];
        this.changedAt[this.row] = time;
      } else if (command === 'A') {
        this.row = Math.max(0, this.row - Number(params || 1));
      }
    }
  }

  put(ch, time) {
    this.rows[this.row] ??= [];
    this.rows[this.row][this.col++] = { ch, ...this.style };
    this.changedAt[this.row] = time;
  }

  sgr(params) {
    const codes = params === '' ? [0] : params.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) this.style = { fg: undefined, bold: false, dim: false };
      else if (code === 1) this.style.bold = true;
      else if (code === 2) this.style.dim = true;
      else if (code === 22) Object.assign(this.style, { bold: false, dim: false });
      else if (code === 39) this.style.fg = undefined;
      else if (code in BASIC) this.style.fg = BASIC[code];
      else if (code === 38 && codes[i + 1] === 5) {
        this.style.fg = xterm256(codes[i + 2]);
        i += 2;
      }
    }
  }

  text(row) {
    return (this.rows[row] ?? []).map((cell) => cell?.ch ?? ' ').join('');
  }
}

/** The 256-color palette: 16 basic colors, a 6x6x6 color cube, then 24 grays. */
function xterm256(code) {
  if (code < 8) return BASIC[30 + code];
  if (code < 16) return BASIC[90 + code - 8];
  if (code >= 232) {
    const v = 8 + (code - 232) * 10;
    return rgb(v, v, v);
  }
  const levels = [0, 95, 135, 175, 215, 255];
  const i = code - 16;
  return rgb(levels[Math.floor(i / 36)], levels[Math.floor(i / 6) % 6], levels[i % 6]);
}

function rgb(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// --- Drawing cells --------------------------------------------------------------------------

const STAR = new Set(['.', '·']);
const SHAPES = new Set(['█', '●', '═', '║', '╔', '╗', '╚', '╝', '│', '━', '╸']);

/**
 * Draws one row of cells at the top edge `y`. In the banner's sky, dots are stars. Returns the
 * stars apart from everything else, so the demo can show them at a different time.
 */
function drawRow(cells, y, { sky = false } = {}) {
  const stars = [];
  const marks = [];
  const at = (i) => cells[i] ?? SPACE;
  let i = 0;
  while (i < cells.length) {
    const cell = at(i);
    const x = i * CELL_W;
    if (cell.ch === ' ') {
      i++;
    } else if (sky && STAR.has(cell.ch)) {
      const big = cell.ch === '·';
      stars.push(
        circle(x + CELL_W / 2, big ? y + CELL_H / 2 : y + BASELINE - 1, big ? 1.1 : 0.8, cell),
      );
      i++;
    } else if (cell.ch === '█') {
      let j = i;
      while (at(j).ch === '█' && sameStyle(at(j), cell)) j++;
      marks.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n((j - i) * CELL_W + 0.3)}" height="${n(CELL_H + 0.3)}"${paint(cell)}/>`,
      );
      i = j;
    } else if (cell.ch === '●') {
      marks.push(circle(x + CELL_W / 2, y + CELL_H / 2, 3.6, cell));
      i++;
    } else if (SHAPES.has(cell.ch)) {
      marks.push(boxChar(cell, x, y));
      i++;
    } else {
      // A run of text in one style. It ends at a wider gap too, so every run starts on the grid.
      let j = i;
      while (
        j < cells.length &&
        !SHAPES.has(at(j).ch) &&
        sameStyle(at(j), cell) &&
        !(at(j).ch === ' ' && at(j + 1).ch === ' ')
      ) {
        j++;
      }
      const run = cells
        .slice(i, j)
        .map((c) => c?.ch ?? ' ')
        .join('')
        .trimEnd();
      if (run) marks.push(text(run, x, y, cell));
      i = j;
    }
  }
  return { stars, marks };
}

function text(run, x, y, cell) {
  const length = [...run].length;
  const weight = cell.bold ? ' font-weight="700"' : '';
  return `<text x="${n(x)}" y="${n(y + BASELINE)}" textLength="${n(length * CELL_W)}" lengthAdjust="spacing"${paint(cell)}${weight}>${xml(run)}</text>`;
}

function circle(cx, cy, r, cell) {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${r}"${paint(cell)}/>`;
}

/** Box-drawing characters as lines through the cell, so they join their neighbors exactly. */
function boxChar(cell, x, y) {
  const [l, r, t, b] = [x, x + CELL_W, y, y + CELL_H];
  const [cx, cy, d] = [x + CELL_W / 2, y + CELL_H / 2, 1.6];
  if (cell.ch === '━' || cell.ch === '╸') {
    const width = cell.ch === '━' ? CELL_W : CELL_W / 2;
    return `<rect x="${n(x)}" y="${n(cy - 1.3)}" width="${n(width)}" height="2.6"${paint(cell)}/>`;
  }
  const lines = {
    '═': [
      [l, cy - d, r, cy - d],
      [l, cy + d, r, cy + d],
    ],
    '║': [
      [cx - d, t, cx - d, b],
      [cx + d, t, cx + d, b],
    ],
    '╔': [
      [r, cy - d, cx - d, cy - d, cx - d, b],
      [r, cy + d, cx + d, cy + d, cx + d, b],
    ],
    '╗': [
      [l, cy - d, cx + d, cy - d, cx + d, b],
      [l, cy + d, cx - d, cy + d, cx - d, b],
    ],
    '╚': [
      [cx - d, t, cx - d, cy + d, r, cy + d],
      [cx + d, t, cx + d, cy - d, r, cy - d],
    ],
    '╝': [
      [cx + d, t, cx + d, cy + d, l, cy + d],
      [cx - d, t, cx - d, cy - d, l, cy - d],
    ],
    '│': [[cx, t, cx, b]],
  }[cell.ch];
  const outline = lines.map(polyline).join('');
  const opacity = cell.dim ? ' stroke-opacity=".55"' : '';
  return `<path d="${outline}" fill="none" stroke="${cell.fg ?? FG}" stroke-width="1.1"${opacity}/>`;
}

/** [x1, y1, x2, y2, ...] as path commands: move to the first point, then draw to the rest. */
function polyline(points) {
  let d = '';
  for (let i = 0; i < points.length; i += 2) {
    d += `${i === 0 ? 'M' : 'L'}${n(points[i])} ${n(points[i + 1])}`;
  }
  return d;
}

function paint(cell) {
  const fill = cell.fg && cell.fg !== FG ? ` fill="${cell.fg}"` : '';
  return `${fill}${cell.dim ? ' fill-opacity=".55"' : ''}`;
}

function sameStyle(a, b) {
  return a.fg === b.fg && a.bold === b.bold && a.dim === b.dim;
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Rounds to two decimals, so the files stay small and stable. */
function n(value) {
  return String(Math.round(value * 100) / 100);
}

// --- Pictures -------------------------------------------------------------------------------

/** A terminal window around `body`, with room for `columns` x `rows` cells. */
function terminal({ columns, rows, title, label, css = '', body }) {
  const innerW = PAD_X * 2 + columns * CELL_W;
  const innerH = TITLE_H + PAD_Y * 2 + rows * CELL_H;
  const width = innerW + MARGIN * 2;
  const height = innerH + MARGIN * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-labelledby="title">
<title id="title">${xml(label)}</title>
<style>
text{font-family:${MONO};font-size:${FONT_SIZE}px;white-space:pre}
.title{font-family:${SANS};font-size:12.5px;fill:#8b949e}
${css}
</style>
<defs>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#010409" flood-opacity=".28"/></filter>
<clipPath id="window"><rect x="${MARGIN}" y="${MARGIN}" width="${n(innerW)}" height="${n(innerH)}" rx="10"/></clipPath>
</defs>
<rect x="${MARGIN}" y="${MARGIN}" width="${n(innerW)}" height="${n(innerH)}" rx="10" fill="${BG}" filter="url(#shadow)"/>
<rect x="${MARGIN}" y="${MARGIN}" width="${n(innerW)}" height="${n(innerH)}" rx="10" fill="${BG}"/>
<g clip-path="url(#window)">
<rect x="${MARGIN}" y="${MARGIN}" width="${n(innerW)}" height="${TITLE_H}" fill="${TITLE_BG}"/>
<rect x="${MARGIN}" y="${MARGIN + TITLE_H - 1}" width="${n(innerW)}" height="1" fill="${BORDER}"/>
</g>
<circle cx="${MARGIN + 20}" cy="${MARGIN + TITLE_H / 2}" r="6" fill="#ff5f57"/>
<circle cx="${MARGIN + 40}" cy="${MARGIN + TITLE_H / 2}" r="6" fill="#febc2e"/>
<circle cx="${MARGIN + 60}" cy="${MARGIN + TITLE_H / 2}" r="6" fill="#28c840"/>
<text class="title" x="${n(MARGIN + innerW / 2)}" y="${MARGIN + TITLE_H / 2 + 4}" text-anchor="middle">${xml(title)}</text>
<rect x="${MARGIN + 0.5}" y="${MARGIN + 0.5}" width="${n(innerW - 1)}" height="${n(innerH - 1)}" rx="9.5" fill="none" stroke="${BORDER}"/>
<g transform="translate(${MARGIN + PAD_X} ${MARGIN + TITLE_H + PAD_Y})" fill="${FG}">
${body}
</g>
</svg>
`;
}

/** The scan as a person sees it: typed command, banner sweep, results, next prompt. */
function demoSvg({ writes, end }) {
  const screen = new Screen();
  screen.write(`${PROMPT}${COMMAND}\n`);
  for (const { time, text: chunk } of writes) screen.write(chunk, ENTER + time);
  const lastRow = screen.row;
  screen.write(PROMPT, ENTER + end + 0.25);

  const tagline = screen.rows.findIndex((_, row) => screen.text(row).includes('risk scanner'));
  if (tagline === -1) throw new Error('no banner in the recording; is the width too small?');
  const sky = { first: tagline - 9, last: tagline - 1 };
  const bannerStart = ENTER + (writes[0]?.time ?? 0);
  const bannerTime = screen.changedAt[tagline] - bannerStart;

  const y = (row) => row * CELL_H;
  const delay = (seconds) => `style="animation-delay:${n(seconds)}s"`;
  const parts = [];

  // The prompt and the command, typed behind a cover that steps right one character at a time.
  parts.push(...drawRow(screen.rows[0], 0).marks);
  const typed = COMMAND.length * CELL_W;
  const typeTime = COMMAND.length * TYPE_PER_CHAR;
  const typeAt = PROMPT_WIDTH * CELL_W;
  parts.push(
    `<rect class="cover type" x="${n(typeAt)}" y="0" width="${n(typed + CELL_W)}" height="${CELL_H}" fill="${BG}"/>`,
    `<rect class="cursor" x="${n(typeAt)}" y="1" width="${CELL_W}" height="${CELL_H - 2}" fill="${FG}" fill-opacity=".8"/>`,
  );

  // The banner: stars first, then the word swept in from the left behind a moving glow.
  const stars = [];
  const word = [];
  for (let row = sky.first; row <= sky.last; row++) {
    const drawn = drawRow(screen.rows[row] ?? [], y(row), { sky: true });
    stars.push(...drawn.stars);
    word.push(...drawn.marks);
  }
  // The word's box: the rows with letter strokes, from its first column to its last.
  const artRows = [];
  for (let row = sky.first; row <= sky.last; row++) {
    if ([...screen.text(row)].some((ch) => SHAPES.has(ch))) artRows.push(row);
  }
  const letterColumns = artRows.flatMap((row) =>
    (screen.rows[row] ?? []).flatMap((cell, col) => (cell && SHAPES.has(cell.ch) ? [col] : [])),
  );
  const wordX = Math.min(...letterColumns) * CELL_W;
  const wordW = (Math.max(...letterColumns) + 1) * CELL_W - wordX;
  const wordY = y(artRows[0]);
  const wordH = artRows.length * CELL_H;
  // The cover hides the word and slides right; the glow rides just behind its left edge, over the
  // last few columns revealed, as in the terminal. Both start and end outside the clip.
  const clip = { x: wordX - 1, w: wordW + 2 };
  const glowW = 3 * CELL_W;
  const glowX = clip.x - glowW - 2;
  const travel = clip.w + glowW + 2;
  parts.push(
    `<g class="a" ${delay(bannerStart)}>${stars.join('')}${word.join('')}</g>`,
    `<clipPath id="word"><rect x="${n(clip.x)}" y="${n(wordY)}" width="${n(clip.w)}" height="${n(wordH + 1)}"/></clipPath>`,
    `<g clip-path="url(#word)">`,
    `<rect class="cover sweep" x="${n(clip.x)}" y="${n(wordY)}" width="${n(clip.w)}" height="${n(wordH + 1)}" fill="${BG}"/>`,
    `<rect class="cover sweep" x="${n(glowX)}" y="${n(wordY)}" width="${n(glowW)}" height="${n(wordH + 1)}" fill="url(#glow)"/>`,
    '</g>',
    '<linearGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".35"/></linearGradient>',
  );

  // Everything after the banner appears when it was written.
  for (let row = tagline; row < lastRow; row++) {
    const { marks } = drawRow(screen.rows[row] ?? [], y(row));
    if (marks.length > 0)
      parts.push(`<g class="a" ${delay(screen.changedAt[row])}>${marks.join('')}</g>`);
  }

  // The next prompt, with a resting cursor.
  const { marks: prompt } = drawRow(screen.rows[lastRow], y(lastRow));
  parts.push(
    `<g class="a" ${delay(screen.changedAt[lastRow])}>${prompt.join('')}<rect x="${n(typeAt)}" y="${n(y(lastRow) + 1)}" width="${CELL_W}" height="${CELL_H - 2}" fill="${FG}" fill-opacity=".8"/></g>`,
  );

  // Without animation, every element shows its final state: covers and the typing cursor are
  // hidden, and everything else is visible. Animation runs only for viewers who haven't asked
  // their system to reduce motion.
  const css = `.cover,.cursor{opacity:0}
@media (prefers-reduced-motion:no-preference){
.a{animation:show .01s linear both}
.type{animation:type ${n(typeTime)}s steps(${COMMAND.length},end) ${TYPE_START}s both}
.cursor{animation:move ${n(typeTime)}s steps(${COMMAND.length},end) ${TYPE_START}s both,on ${n(ENTER)}s linear}
.sweep{animation:sweep ${n(bannerTime)}s linear ${n(bannerStart)}s both}
}
@keyframes show{from{opacity:0}to{opacity:1}}
@keyframes on{from{opacity:1}to{opacity:1}}
@keyframes move{from{transform:translateX(0)}to{transform:translateX(${n(typed)}px)}}
@keyframes type{0%{transform:translateX(0);opacity:1}99.9%{transform:translateX(${n(typed)}px);opacity:1}100%{transform:translateX(${n(typed)}px);opacity:0}}
@keyframes sweep{0%{transform:translateX(0);opacity:1}99.9%{transform:translateX(${n(travel)}px);opacity:1}100%{transform:translateX(${n(travel)}px);opacity:0}}`;

  return terminal({
    columns: DEMO_COLUMNS,
    rows: lastRow + 1,
    title: 'devsweep',
    label:
      'A terminal running npx @frank1738/devsweep --offline in a sample repository. The DEVSWEEP banner sweeps in, then 10 findings are listed by file: 1 critical, 6 high, 2 medium and 1 low.',
    css,
    body: parts.join('\n'),
  });
}

/** The first two findings of the --details report, as a still picture. */
function detailsSvg({ writes }) {
  const screen = new Screen();
  for (const { text: chunk } of writes) screen.write(chunk);
  const texts = screen.rows.map((_, row) => screen.text(row).trim());
  const first = texts.indexOf('.github/workflows/pr-preview.yml');
  const last = texts.indexOf('workflow/unpinned-action');
  if (first === -1 || last === -1) throw new Error('the --details output changed; update the crop');

  const rows = screen.rows.slice(first, last + 1);
  const body = rows
    .map((cells, row) => drawRow(cells ?? [], row * CELL_H).marks.join(''))
    .join('\n');
  return terminal({
    columns: DETAILS_COLUMNS,
    rows: rows.length,
    title: 'devsweep --details',
    label:
      'Two findings from devsweep --details. Each one explains the risk, shows the lines of the workflow involved with the problem underlined, gives the fix, and names the rule that found it.',
    body,
  });
}

await run();
