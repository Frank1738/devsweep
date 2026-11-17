import { list } from '../../format.js';
import { createFinding, type Finding, type Position, type Rule } from '../../types.js';
import { allStrings, field, type JsonEntry, type JsonValue } from './jsonc.js';

export const TASKS_FILE = '.vscode/tasks.json';
export const SETTINGS_FILE = '.vscode/settings.json';

export const autorunTask: Rule = {
  id: 'code/autorun-task',
  title: 'Task runs when the folder opens',
  severity: 'medium',
  description:
    'A VS Code task with "runOn": "folderOpen" runs a command as soon as someone opens the ' +
    "folder, before they've read any of the code. The PolinRider malware campaign hides its " +
    'loader this way in fake take-home assignments and infected repositories. Some real projects ' +
    'use it to start a file watcher, so a plain auto-run task is medium. It is critical when the ' +
    "task also runs node, a shell or python on a file that isn't a script (such as a font), " +
    'pipes a download into a shell, hides its output, or contacts a vercel.app /settings/ ' +
    'address. It is high when .vscode/settings.json also sets "task.allowAutomaticTasks" to ' +
    '"on", which tries to let tasks run without VS Code asking first.',
  remediation:
    'Open .vscode/tasks.json in a plain text editor, without opening the folder in VS Code, and ' +
    'read the task\'s "command" and "args" to see what it runs. If you don\'t recognise the ' +
    'task, delete it from the "tasks" list, and check the files it names and the rest of the ' +
    'repository before you open it in VS Code. If the project really needs it, accept the ' +
    'finding in devsweep.config.json. Either way, set "task.allowAutomaticTasks": "off" in your ' +
    'own VS Code user settings, so no folder can run tasks without asking you.',
};

const PLATFORMS = [
  ['windows', 'Windows'],
  ['osx', 'macOS'],
  ['linux', 'Linux'],
] as const;

/** Interpreters, and the file extensions of the scripts each one normally runs. */
const SCRIPT_EXTENSIONS: Record<string, readonly string[]> = {
  node: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'],
  bash: ['sh', 'bash'],
  sh: ['sh', 'bash'],
  python: ['py', 'pyw'],
  powershell: ['ps1', 'psm1'],
};

/** Other names the same interpreters go by. */
const INTERPRETER_ALIASES: Record<string, string> = {
  nodejs: 'node',
  zsh: 'bash',
  dash: 'sh',
  python2: 'python',
  python3: 'python',
  py: 'python',
  pwsh: 'powershell',
};

/**
 * Options that end the search for a file: what follows is inline code or a module name. Matched
 * exactly, since `-c` and `-C` differ for most of these programs.
 */
const INLINE_CODE_OPTIONS = new Set(['-c', '-e', '--eval', '-p', '--print', '-m']);
/** Options whose value is the next word, which is not the file being run. Matched exactly. */
const VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '-W', '-X']);
/** PowerShell's options, which ignore case: -Command takes code, the others a value. */
const POWERSHELL_INLINE_CODE = new Set(['-command', '-c', '-encodedcommand', '-ec']);
const POWERSHELL_VALUE_OPTIONS = new Set(['-executionpolicy', '-ep', '-windowstyle']);
/** Words after which a new command starts. */
const SEPARATORS = new Set(['&&', '||', '|', ';', '&', '/c', '/k']);

const FONT_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp']);

/** `curl … | bash`, `wget … | sh`, and the same with sudo. */
const CURL_TO_SHELL = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i;
/** `bash -c "$(curl …)"` and `bash <(curl …)`. */
const SHELL_RUNS_DOWNLOAD = /\b(?:ba|z|da)?sh\s+(?:-c\s+)?["']?(?:\$\(|<\()\s*(?:curl|wget)\b/i;
/** `iwr … | iex`, `Invoke-WebRequest … | Invoke-Expression`, and `irm`. */
const WEB_REQUEST_TO_IEX =
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]*\|\s*(?:iex|invoke-expression)\b/i;
/** A vercel.app address with a /settings/ path, the shape of PolinRider's servers. */
const VERCEL_SETTINGS =
  /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)+vercel\.app(?::\d+)?(?:\/[^\s"'`|]*)?\/settings\//i;

const MAX_LABEL_IN_MESSAGE = 60;

export interface AutorunSettings {
  /** .vscode/settings.json sets "task.allowAutomaticTasks" to "on". */
  allowAutomaticTasks: boolean;
}

/** Reports each task in a parsed tasks.json that runs when the folder opens. */
export function analyze(tasksJson: JsonValue, settings: AutorunSettings): Finding[] {
  const tasks = field(tasksJson, 'tasks')?.value;
  if (tasks?.kind !== 'array') return [];
  const rootPresentation = field(tasksJson, 'presentation')?.value;

  return tasks.items.flatMap((task, index) => {
    if (task.kind !== 'object') return [];
    const trigger = autorunTrigger(task);
    if (!trigger) return [];

    const name = taskName(task, index);
    const signals = dangerSignals(task, rootPresentation);
    const when =
      trigger.platforms === undefined
        ? 'runs automatically when the folder opens'
        : `runs automatically when the folder opens on ${trigger.platforms}`;
    const allowed = settings.allowAutomaticTasks;

    let message = `${name.display} ${when}`;
    if (signals.length > 0) message += `, and ${list(signals)}`;
    message += '.';
    if (allowed) {
      message +=
        ` ${SETTINGS_FILE} also sets "task.allowAutomaticTasks" to "on", which tries to let ` +
        'tasks run without VS Code asking first.';
    }

    return [
      createFinding(autorunTask, {
        file: TASKS_FILE,
        at: trigger.at,
        subject: name.subject,
        message,
        severity: signals.length > 0 ? 'critical' : allowed ? 'high' : 'medium',
        remediation:
          `Read this task's "command" and "args" in ${TASKS_FILE} with a plain text editor, ` +
          "without opening the folder in VS Code. If you don't recognise it, delete the task and " +
          'check the files it names. Set "task.allowAutomaticTasks": "off" in your own VS Code ' +
          'user settings, so no folder can run tasks without asking you.',
      }),
    ];
  });
}

/**
 * Finds `"runOptions": { "runOn": "folderOpen" }` on the task itself or in its windows, osx or
 * linux block. Returns where the first one is, and which platforms it is limited to, if any.
 */
function autorunTrigger(task: JsonValue): { at: Position; platforms?: string } | undefined {
  const own = folderOpen(task);
  if (own) return { at: own.keyAt };
  const matches = PLATFORMS.flatMap(([key, label]) => {
    const entry = folderOpen(field(task, key)?.value);
    return entry ? [{ entry, label }] : [];
  });
  const [first] = matches;
  if (!first) return undefined;
  return { at: first.entry.keyAt, platforms: list(matches.map((m) => m.label)) };
}

function folderOpen(block: JsonValue | undefined): JsonEntry | undefined {
  const runOn = field(field(block, 'runOptions')?.value, 'runOn');
  return runOn?.value.kind === 'string' && runOn.value.value === 'folderOpen' ? runOn : undefined;
}

/** What the task shows in a finding, and the subject used to accept it in the config file. */
function taskName(task: JsonValue, index: number): { display: string; subject: string } {
  // VS Code names an unlabelled npm task after its script.
  const script = text(field(task, 'script')?.value);
  const npmLabel =
    text(field(task, 'type')?.value) === 'npm' && script !== undefined
      ? `npm: ${script}`
      : undefined;
  const label =
    text(field(task, 'label')?.value) ?? text(field(task, 'taskName')?.value) ?? npmLabel;
  if (label !== undefined) {
    const short =
      label.length > MAX_LABEL_IN_MESSAGE ? `${label.slice(0, MAX_LABEL_IN_MESSAGE - 1)}…` : label;
    return { display: `Task "${short}"`, subject: label };
  }
  return { display: `Task ${index + 1} (no label)`, subject: `task ${index + 1}` };
}

/** The reasons, in plain words, that make this auto-run task critical. Never quotes the command. */
function dangerSignals(task: JsonValue, rootPresentation: JsonValue | undefined): string[] {
  const signals = new Set<string>();

  // The command that runs on each platform: a platform block's command and args replace the
  // task's own.
  const variants = [
    task,
    ...PLATFORMS.flatMap(([key]) => {
      const block = field(task, key)?.value;
      return block?.kind === 'object' ? [block] : [];
    }),
  ];
  for (const variant of variants) {
    const command = field(variant, 'command')?.value ?? field(task, 'command')?.value;
    const args = field(variant, 'args')?.value ?? field(task, 'args')?.value;
    const words = [...commandWords(command), ...commandWords(args)];
    for (const signal of interpreterOnData(words)) signals.add(signal);
  }

  // Downloads and addresses can sit anywhere in the task, e.g. in an environment variable.
  const everything = allStrings(task).join(' ');
  if (
    CURL_TO_SHELL.test(everything) ||
    SHELL_RUNS_DOWNLOAD.test(everything) ||
    WEB_REQUEST_TO_IEX.test(everything)
  ) {
    signals.add('downloads a script and runs it in a shell');
  }

  const presentations = [
    field(task, 'presentation')?.value,
    ...PLATFORMS.map(([key]) => field(field(task, key)?.value, 'presentation')?.value),
  ];
  // A presentation setting at the top of tasks.json applies to every task that doesn't set its own.
  const setting = (key: string): (JsonValue | undefined)[] => {
    const own = presentations.flatMap((p) => field(p, key)?.value ?? []);
    return own.length > 0 ? own : [field(rootPresentation, key)?.value];
  };
  if (setting('reveal').some((v) => v?.kind === 'string' && v.value === 'never')) {
    signals.add('hides its terminal');
  }
  if (setting('echo').some((v) => v?.kind === 'literal' && v.value === false)) {
    signals.add("doesn't show the command it runs");
  }

  if (VERCEL_SETTINGS.test(everything)) {
    signals.add('contacts a vercel.app /settings/ address, a pattern PolinRider uses');
  }

  return [...signals];
}

/**
 * Finds an interpreter (node, bash, sh, python, powershell) at the start of a command, and checks
 * the file it runs. Returns e.g. "runs node on a font file" when that file isn't a script.
 */
function interpreterOnData(words: readonly string[]): string[] {
  const found: string[] = [];
  let commandStart = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (SEPARATORS.has(word.toLowerCase())) {
      commandStart = true;
      continue;
    }
    if (!commandStart) continue;
    commandStart = false;

    const interpreter = interpreterName(word);
    if (interpreter === undefined) continue;
    const file = fileArgument(words, i + 1, interpreter === 'powershell');
    if (file === undefined) continue;
    if (file.inline) {
      // What follows -c or -e is code, which may start another command.
      commandStart = true;
      i = file.index - 1;
      continue;
    }
    const extension = extensionOf(file.word);
    const scripts = SCRIPT_EXTENSIONS[interpreter] ?? [];
    if (extension !== undefined && !scripts.includes(extension)) {
      found.push(`runs ${interpreter} on ${describeFile(extension)}`);
    }
  }
  return found;
}

/** The first word after an interpreter that names the file it runs, skipping options. */
function fileArgument(
  words: readonly string[],
  from: number,
  powershell: boolean,
): { word: string; index: number; inline: boolean } | undefined {
  for (let i = from; i < words.length; i++) {
    const word = words[i] ?? '';
    const lower = word.toLowerCase();
    if (SEPARATORS.has(lower)) return undefined;
    const inline = powershell ? POWERSHELL_INLINE_CODE.has(lower) : INLINE_CODE_OPTIONS.has(word);
    if (inline) return { word, index: i + 1, inline: true };
    const value = powershell ? POWERSHELL_VALUE_OPTIONS.has(lower) : VALUE_OPTIONS.has(word);
    if (value) {
      i++;
      continue;
    }
    // Other options, including PowerShell's -File, which comes right before the script.
    if (word.startsWith('-')) continue;
    return { word, index: i, inline: false };
  }
  return undefined;
}

function interpreterName(word: string): string | undefined {
  const base = (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  const name = INTERPRETER_ALIASES[base] ?? base;
  return name in SCRIPT_EXTENSIONS ? name : undefined;
}

/** The file's extension in lower case, or undefined when it has none. */
function extensionOf(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? '';
  const match = /\.([a-z0-9]{1,10})$/i.exec(base);
  // ".env"-style names with nothing before the dot count as having no extension.
  return match && match.index > 0 ? match[1]?.toLowerCase() : undefined;
}

function describeFile(extension: string): string {
  if (FONT_EXTENSIONS.has(extension)) return 'a font file';
  if (IMAGE_EXTENSIONS.has(extension)) return 'an image file';
  return `a ".${extension}" file, which isn't a script`;
}

/**
 * The words of a command or args value. VS Code accepts a string, a list of strings, or
 * `{ "value": …, "quoting": … }` in place of any string.
 */
function commandWords(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (value.kind === 'string') {
    // A whole value that names an interpreter is one program, even with spaces in its path,
    // such as C:\Program Files\nodejs\node.exe.
    const whole = value.value.trim();
    return interpreterName(whole) !== undefined ? [whole] : splitWords(whole);
  }
  if (value.kind === 'array') return value.items.flatMap(commandWords);
  if (value.kind === 'object') return commandWords(field(value, 'value')?.value);
  return [];
}

/**
 * Splits on blanks and around `;`, `|` and `&`, and drops quotes so `"node"` and `'node'` read
 * as node.
 */
function splitWords(command: string): string[] {
  return command
    .replace(/&&|\|\||[;|&]/g, ' $& ')
    .split(/\s+/)
    .map((word) => word.replace(/^["'`]+|["'`]+$/g, ''))
    .filter((word) => word !== '');
}

function text(value: JsonValue | undefined): string | undefined {
  return value?.kind === 'string' && value.value !== '' ? value.value : undefined;
}
