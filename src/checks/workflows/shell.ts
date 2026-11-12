import type { Script } from './parse.js';

/**
 * Just enough shell parsing to find commands in `run:` scripts. Words are split on whitespace,
 * then quotes are removed from words that open and close them (`"main"` → `main`). A quoted
 * string with spaces in it stays split and keeps its quotes, so `echo "git push"` never reads
 * as a git command: this errs toward missing a command over inventing one.
 */

export interface ScriptLine {
  /** One logical line, with backslash continuations joined. */
  text: string;
  line: number;
  column?: number;
}

/** Splits a script into logical lines, located in the workflow file. */
export function scriptLines(script: Script): ScriptLine[] {
  const lines: ScriptLine[] = [];
  let pending: { text: string; start: number } | undefined;

  script.value.split('\n').forEach((text, index) => {
    const start = pending?.start ?? index;
    const joined = (pending?.text ?? '') + text;
    const continuation = /\\\s*$/.exec(joined);
    if (continuation) {
      pending = { text: `${joined.slice(0, continuation.index)} `, start };
      return;
    }
    pending = undefined;
    if (joined.trim()) lines.push(locate(script, joined, start));
  });
  if (pending?.text.trim()) lines.push(locate(script, pending.text, pending.start));

  return lines;
}

function locate(script: Script, text: string, index: number): ScriptLine {
  return script.literal
    ? { text, line: script.line + 1 + index }
    : { text, line: script.line, column: script.column };
}

const SEPARATOR = /&&|\|\||[;&|]/;
const COMMENT = /(?:^|\s)#.*$/;
/** A redirection and its target: `2>&1`, `> out.log`, `>>log`, `&>file`, `< in`. */
const REDIRECTION = /(?:\d+|&)?(?:>>?|<)(?:&\d+|\s*[^\s;&|]+)/g;

/** Splits a line into simple commands (split on `&&`, `||`, `;`, `&`, `|`), each a list of words. */
export function simpleCommands(line: string): string[][] {
  return line
    .replace(COMMENT, '')
    .replace(REDIRECTION, ' ')
    .split(SEPARATOR)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean).map(unquote))
    .filter((words) => words.length > 0);
}

/**
 * Removes shell quotes the way the shell would: `'main'`, `"main"` and `HEAD:"main"` all become
 * `main` or `HEAD:main`. A word with a quote left open (`"git`) is returned unchanged, because its
 * string continues in the next word.
 */
function unquote(word: string): string {
  let result = '';
  let open: string | undefined;
  for (const char of word) {
    if (open === undefined && (char === '"' || char === "'")) open = char;
    else if (char === open) open = undefined;
    else result += char;
  }
  return open === undefined ? result : word;
}

/** Words that can come before a command without changing which command runs. */
const COMMAND_PREFIXES = new Set([
  '!',
  '{',
  'then',
  'do',
  'else',
  'if',
  'while',
  'until',
  'time',
  'sudo',
  'exec',
  'command',
  'env',
]);
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const GIT = /^(?:.*[\\/])?git(?:\.exe)?$/;
/** git's global options that take a separate value. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c']);

/** If `words` is a `git push` command, returns the arguments after `push`. */
export function gitPushArgs(words: readonly string[]): string[] | undefined {
  let i = 0;
  while (COMMAND_PREFIXES.has(words[i] ?? '') || ENV_ASSIGNMENT.test(words[i] ?? '')) i++;
  if (!GIT.test(words[i] ?? '')) return undefined;
  i++;
  while ((words[i] ?? '').startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(words[i] ?? '') ? 2 : 1;
  return words[i] === 'push' ? words.slice(i + 1) : undefined;
}
