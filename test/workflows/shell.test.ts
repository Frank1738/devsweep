import { describe, expect, it } from 'vitest';
import type { Script } from '../../src/checks/workflows/parse.js';
import { gitPushArgs, scriptLines, simpleCommands } from '../../src/checks/workflows/shell.js';

function literal(value: string): Script {
  return { value, line: 10, column: 14, literal: true };
}

describe('scriptLines', () => {
  it('locates each line of a literal block script, skipping blank lines', () => {
    expect(scriptLines(literal('npm ci\n\nnpm test\n'))).toEqual([
      { text: 'npm ci', line: 11 },
      { text: 'npm test', line: 13 },
    ]);
  });

  it('joins backslash continuations and reports the line they start on', () => {
    const lines = scriptLines(literal('git push \\\n  --force \\\n  origin main\necho done'));
    expect(lines.map((l) => [l.text.replace(/\s+/g, ' '), l.line])).toEqual([
      ['git push --force origin main', 11],
      ['echo done', 14],
    ]);
  });

  it('reports the start of the value for scripts that are not literal blocks', () => {
    expect(scriptLines({ value: 'a\nb', line: 3, column: 12, literal: false })).toEqual([
      { text: 'a', line: 3, column: 12 },
      { text: 'b', line: 3, column: 12 },
    ]);
  });
});

describe('simpleCommands', () => {
  it('splits on separators and drops comments and redirections', () => {
    expect(
      simpleCommands(
        'git add . && git commit -m x; git push origin main > out.log 2>&1 | tee log # done',
      ),
    ).toEqual([
      ['git', 'add', '.'],
      ['git', 'commit', '-m', 'x'],
      ['git', 'push', 'origin', 'main'],
      ['tee', 'log'],
    ]);
  });
});

describe('gitPushArgs', () => {
  it.each([
    ['git push origin main', ['origin', 'main']],
    ['git -C repo push --force', ['--force']],
    ['git -c user.name=bot --no-pager push', []],
    ['sudo git push', []],
    ['GIT_TRACE=1 git push -f', ['-f']],
    ['then git push', []],
    ['/usr/bin/git push', []],
  ])('reads "%s"', (line, args) => {
    expect(gitPushArgs(line.split(' '))).toEqual(args);
  });

  it.each(['echo git push --force', 'git commit -m push', 'git tag -f v1', '"git push --force"'])(
    'ignores "%s"',
    (line) => {
      expect(gitPushArgs(line.split(' '))).toBeUndefined();
    },
  );
});
