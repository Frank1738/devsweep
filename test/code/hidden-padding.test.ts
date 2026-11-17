import { describe, expect, it } from 'vitest';
import {
  analyze,
  appliesTo,
  findPadding,
  MIN_INDENT_PADDING,
  MIN_PADDING,
} from '../../src/checks/code/hidden-padding.js';
import { CANARY, joined, PAYLOAD, pad } from './samples.js';

/** A real-looking config whose last line hides the payload, modelled on the published samples. */
const CONFIG_START = 'export default { plugins: { tailwindcss: {} } };';

describe('findPadding', () => {
  it('finds 64 or more spaces followed by code, and where the code starts', () => {
    expect(findPadding(`${CONFIG_START}${pad(438)}${PAYLOAD}`)).toEqual({
      column: CONFIG_START.length + 438 + 1,
      spaces: 438,
      tabs: 0,
      codeLength: PAYLOAD.length,
      signs: [],
    });
  });

  it('counts tabs, and mixed runs', () => {
    expect(findPadding(`x;${pad(131, '\t')}${PAYLOAD}`)).toMatchObject({ spaces: 0, tabs: 131 });
    expect(findPadding(`x;${pad(100)}${pad(100, '\t')}${PAYLOAD}`)).toMatchObject({
      spaces: 100,
      tabs: 100,
    });
  });

  it('needs at least 64 in a row', () => {
    expect(MIN_PADDING).toBe(64);
    expect(findPadding(`x;${pad(63)}${PAYLOAD}`)).toBeUndefined();
    expect(findPadding(`x;${pad(64)}${PAYLOAD}`)).toBeDefined();
    expect(findPadding(`x;${pad(40)}y;${pad(40)}${PAYLOAD}`)).toBeUndefined();
  });

  it('counts padding at the start of a line from 128, past deep indentation', () => {
    expect(MIN_INDENT_PADDING).toBe(128);
    expect(findPadding(`${pad(776)}${PAYLOAD}`)).toMatchObject({ column: 777, spaces: 776 });
    expect(findPadding(`${pad(128)}${PAYLOAD}`)).toBeDefined();
    expect(findPadding(`${pad(127)}${PAYLOAD}`)).toBeUndefined();
    // Deeply nested HTML in an email template.
    expect(findPadding(`${pad(76)}class="floated-none" style="float: none;"`)).toBeUndefined();
  });

  it.each([
    ['a // note lined up in columns', `//   total = a + b${pad(67)}what the sum shows`],
    ['an indented # note', `    # step one${pad(80)}runs first`],
    ['a -- note', `-- query${pad(80)}explained`],
    ['a JSDoc line', ` * @param a${pad(80)}the first value`],
    ['an open /* comment', `/* table:${pad(80)}column two`],
  ])('skips padding inside %s', (_name, line) => {
    expect(findPadding(line)).toBeUndefined();
  });

  it.each([
    ['a // inside a string', `const u = "https://example.com";${pad(80)}${PAYLOAD}`],
    ['a comment closed before the padding', `/* a */ x;${pad(80)}${PAYLOAD}`],
    ['a line that starts by closing a comment', ` */ x;${pad(80)}${PAYLOAD}`],
  ])('still finds code after %s', (_name, line) => {
    expect(findPadding(line)?.column).toBe(line.indexOf('console') + 1);
  });

  it.each([
    ['a line of only spaces', pad(200)],
    ['a line of only tabs', pad(200, '\t')],
    ['a line ending in spaces', `const a = 1;${pad(200)}`],
    ['a line ending in spaces and a carriage return', `const a = 1;${pad(200)}\r`],
    ['padding before a // comment', `const a = 1;${pad(100)}// note`],
    ['padding before a # comment', `key: value${pad(100)}# note`],
    ['padding before a -- comment', `SELECT 1;${pad(100)}-- note`],
    ['padding before a block comment that ends the line', `x;${pad(100)}/* note */   `],
    ['padding before an unclosed block comment', `x;${pad(100)}/* note`],
    ['padding before an HTML comment', `<p>${pad(100)}<!-- note -->`],
    ['padding before a JSDoc line', `${pad(100)}* @param a`],
  ])('skips %s', (_name, line) => {
    expect(findPadding(line)).toBeUndefined();
  });

  it('still finds code that follows a block comment on the same line', () => {
    const line = `x;${pad(100)}/* note */ ${PAYLOAD}`;
    expect(findPadding(line)?.column).toBe(line.indexOf('console') + 1);
  });

  it('stops at the end of the code, not at trailing spaces', () => {
    expect(findPadding(`x;${pad(100)}${PAYLOAD}${pad(10)}`)?.codeLength).toBe(PAYLOAD.length);
  });

  describe('signs that make it critical', () => {
    it.each([
      ['eval(', 'eval(x)', 'runs text as code (eval)'],
      ['atob(', 'var s = atob(x);', 'decodes base64 (atob)'],
      ['new Function(', 'new Function(x)();', 'builds a function from text (new Function)'],
      ['Buffer.from with base64', "Buffer.from(x, 'base64')", 'decodes base64 (Buffer.from)'],
      ['a global[...] assignment', joined('global', "['_x']='1';"), 'sets a global variable'],
      ['a global. assignment', joined('global', '.o = 1;'), 'sets a global variable'],
      ['a globalThis assignment', joined('globalThis', '.q=1'), 'sets a global variable'],
      [
        'require put on a global',
        joined('global', "['r'] = require;"),
        'puts require or module on a global variable',
      ],
      [
        'module put on a global',
        joined('global', '.m=module'),
        'puts require or module on a global variable',
      ],
    ])('%s', (_name, code, sign) => {
      expect(findPadding(`x;${pad(100)}${code}`)?.signs).toEqual([sign]);
    });

    it.each([
      ['a longer name ending in eval', 'myeval(x)'],
      ['a comparison with a global', joined('global', '.x == 1')],
      ['an arrow function', joined('global', '.x => 1')],
      ['a name that only starts like global', joined('globalize', '.x = 1')],
      ['Buffer.from without base64', "Buffer.from(x, 'utf8')"],
    ])('ignores %s', (_name, code) => {
      expect(findPadding(`x;${pad(100)}${code}`)?.signs).toEqual([]);
    });

    it('lists every sign found', () => {
      const code = joined('global', "['r']=require;eval(atob(x))");
      expect(findPadding(`x;${pad(100)}${code}`)?.signs).toEqual([
        'runs text as code (eval)',
        'decodes base64 (atob)',
        'puts require or module on a global variable',
      ]);
    });

    it('only looks at the code after the padding', () => {
      expect(findPadding(`eval(x);${pad(100)}${PAYLOAD}`)?.signs).toEqual([]);
    });
  });

  it('reads a line megabytes long quickly', () => {
    const long = `${CONFIG_START}${pad(149)}${'a'.repeat(5_000_000)}`;
    const blank = pad(5_000_000);
    // Text that starts many matches but finishes none.
    const decoys = `x;${pad(100)}${joined('global', '[').repeat(500_000)}${'Buffer.from('.repeat(200_000)}`;
    const started = performance.now();
    expect(findPadding(long)?.codeLength).toBe(5_000_000);
    expect(findPadding(blank)).toBeUndefined();
    expect(findPadding(decoys)?.signs).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('analyze', () => {
  it('reports the padded line at its line and column, as high', () => {
    const text = `// tailwind config\n\n${CONFIG_START}${pad(438)}${PAYLOAD}\n`;
    expect(analyze('tailwind.config.js', text)).toEqual([
      expect.objectContaining({
        ruleId: 'code/hidden-padding',
        severity: 'high',
        file: 'tailwind.config.js',
        line: 3,
        column: CONFIG_START.length + 438 + 1,
        message:
          `438 spaces, then ${PAYLOAD.length} characters of code at column ` +
          `${CONFIG_START.length + 439}. Code this far right is off-screen in most editors, ` +
          'which is how the PolinRider campaign hides its loader.',
      }),
    ]);
  });

  it('is critical when the hidden code runs or decodes something', () => {
    // The base64 decodes to console.log(1).
    const code = 'eval(atob("Y29uc29sZS5sb2coMSk="))';
    const [finding] = analyze('lib/index.js', `${CONFIG_START}${pad(131, '\t')}${code}\n`);
    expect(finding?.severity).toBe('critical');
    expect(finding?.message).toContain(
      `131 tabs, then ${code.length} characters of code at column ${CONFIG_START.length + 132}.`,
    );
    expect(finding?.message).toContain(
      'The hidden code runs text as code (eval) and decodes base64 (atob).',
    );
  });

  it('gives one finding per file, at the most telling line, naming the others', () => {
    const lines = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'x;' : `y;${pad(80)}z;`));
    lines.push(`w;${pad(80)}eval(x)`);
    const findings = analyze('gen.js', lines.join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 11, severity: 'critical' });
    expect(findings[0]?.message).toContain(
      '5 other lines in this file are padded the same way: 2, 4, 6, 8 and 10.',
    );
    lines.push(`v;${pad(80)}u;`);
    expect(analyze('gen.js', lines.join('\n'))[0]?.message).toContain(
      '6 other lines in this file are padded the same way: 2, 4, 6, 8, 10 and 1 more.',
    );
  });

  it('counts lines and columns the same with Windows line endings', () => {
    const [finding] = analyze('a.js', `a;\r\nb;\r\nc;${pad(70)}${PAYLOAD}\r\n`);
    expect(finding).toMatchObject({ line: 3, column: 73 });
    expect(finding?.message).toContain(`then ${PAYLOAD.length} characters`);
  });

  it('never quotes the hidden code', () => {
    const [finding] = analyze('a.js', `a;${pad(70)}${PAYLOAD}`);
    expect(JSON.stringify(finding)).not.toContain(CANARY);
  });

  it('reports nothing for a clean file', () => {
    expect(analyze('a.js', 'const a = 1;\n    const b = 2;\n')).toEqual([]);
  });
});

describe('appliesTo', () => {
  it('skips Markdown, .txt, .csv and source map files, in any case', () => {
    for (const file of ['README.md', 'docs/NOTES.MD', 'notes.txt', 'data/table.csv', 'a.js.map']) {
      expect(appliesTo(file)).toBe(false);
    }
    for (const file of ['init', 'index.php', 'a.config.mjs', '.gitignore', 'x.md.js']) {
      expect(appliesTo(file)).toBe(true);
    }
  });
});
