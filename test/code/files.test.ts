// The rules that read every file, run through the code check and the CLI as a user would.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeCheck, GENERATED_FOLDERS, MAX_TEXT_BYTES } from '../../src/checks/code/index.js';
import { main } from '../../src/cli.js';
import { SOURCE_HIDDEN_NOTE } from '../../src/reporters/pretty.js';
import type { ScanContext } from '../../src/types.js';
import { CANARY, create, fixedMarkers, joined, markerOfKind, PAYLOAD, pad } from './samples.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-files-'));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function run(root = temp, skipFolders?: string[]) {
  const warnings: { file: string | undefined; message: string }[] = [];
  let filesRead = false;
  const ctx: ScanContext = {
    root,
    skipFolders,
    warn: (message, file) => warnings.push({ file, message }),
    scannedFile: () => {
      filesRead = true;
    },
    scannedGitHub: () => {},
    repository: async () => undefined,
    offline: true,
    env: {},
    fetch: globalThis.fetch,
  };
  const findings = await codeCheck.run(ctx);
  return { findings, warnings, filesRead };
}

const NOT_A_FONT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xfe, 0x01]);
const REAL_WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.from([0x00, 0x01, 0x00, 0x00])]);
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 10\n';

/** A project shaped like an infected take-home assignment, with every trap beside it. */
async function infectedProject(): Promise<void> {
  await create(temp, {
    'postcss.config.mjs': `export default { plugins: {} };\n${pad(10)}\nconst a = 1;${pad(149)}${joined('global', "['r']=require;")}${PAYLOAD}\n`,
    'public/fonts/icons-400.woff2': `(function(){${PAYLOAD}})();`,
    'public/fonts/real.woff2': REAL_WOFF2,
    'public/fonts/broken.ttf': NOT_A_FONT,
    'public/fonts/lfs.woff2': LFS_POINTER,
    'public/fonts/empty.otf': '',
    '.vscode/tasks.json': JSON.stringify({
      version: '2.0.0',
      tasks: [{ label: 'fonts', command: 'node ./public/fonts/icons-400.woff2' }],
    }),
    'scripts/temp_auto_push.bat': '@echo off\r\nrem fixture\r\n',
    '.gitignore': 'node_modules/\nconfig.bat\n',
    'src/app.js': `const ok = true;\nrun(${JSON.stringify(markerOfKind('stage 2 marker'))});\n`,
    // Skipped: Markdown, .txt and .csv files quote markers and pad tables.
    'README.md': `| a |${pad(100)}| b |\n${markerOfKind('obfuscator marker')}\n`,
    'notes.txt': `a${pad(100)}b\n`,
    'data.csv': `a,${pad(100)}b\n`,
  });
}

describe('the rules that read every file', () => {
  it('flags each sign of PolinRider at the right place and severity', async () => {
    await infectedProject();
    const { findings, warnings } = await run();
    expect(warnings).toEqual([]);
    expect(
      findings
        .map((f) => [f.ruleId, f.file, f.line, f.column, f.severity])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['code/propagation-script', '.gitignore', 2, 1, 'medium'],
      ['code/hidden-padding', 'postcss.config.mjs', 3, 162, 'critical'],
      ['code/disguised-file', 'public/fonts/broken.ttf', 1, undefined, 'high'],
      ['code/disguised-file', 'public/fonts/icons-400.woff2', 1, undefined, 'critical'],
      ['code/propagation-script', 'scripts/temp_auto_push.bat', 1, undefined, 'critical'],
      ['code/known-marker', 'src/app.js', 2, 6, 'critical'],
    ]);
    const font = findings.find((f) => f.file === 'public/fonts/icons-400.woff2');
    expect(font?.message).toContain('A command in .vscode/tasks.json names it.');
  });

  it('records that it read files, so the report can tell "nothing to scan" apart', async () => {
    await infectedProject();
    expect((await run()).filesRead).toBe(true);
  });

  it("doesn't count binary files it skips as read", async () => {
    await create(temp, { 'logo.png': NOT_A_FONT });
    const { findings, filesRead } = await run();
    expect(findings).toEqual([]);
    expect(filesRead).toBe(false);
  });

  it('names a font run by an npm script', async () => {
    await create(temp, {
      'assets/x.ttf': NOT_A_FONT,
      'package.json': JSON.stringify({ scripts: { postinstall: 'node assets/X.ttf' } }),
    });
    const { findings } = await run();
    expect(findings).toEqual([
      expect.objectContaining({ file: 'assets/x.ttf', severity: 'critical' }),
    ]);
    expect(findings[0]?.message).toContain('A command in package.json names it.');
  });

  it('flags a propagation script by its name, even when its content is binary', async () => {
    await create(temp, { 'TEMP_INTERACTIVE_PUSH.BAT': NOT_A_FONT });
    expect((await run()).findings).toEqual([
      expect.objectContaining({ ruleId: 'code/propagation-script', severity: 'critical' }),
    ]);
  });

  it('flags a fake font in the files a nested project holds', async () => {
    await create(temp, { 'apps/web/.git/HEAD': 'ref', 'apps/web/fa-solid.lkf': PAYLOAD });
    expect((await run()).findings.map((f) => f.file)).toEqual(['apps/web/fa-solid.lkf']);
  });

  it('leaves out the folders in skipFolders, which --all scans as their own projects', async () => {
    await create(temp, {
      'a.js': `x;${pad(70)}${PAYLOAD}`,
      'apps/web/b.js': `x;${pad(70)}${PAYLOAD}`,
    });
    const { findings } = await run(temp, ['apps/web']);
    expect(findings.map((f) => f.file)).toEqual(['a.js']);
  });

  it("doesn't enter build tools' generated folders, such as .next", async () => {
    await create(temp, {
      'a.js': `x;${pad(70)}${PAYLOAD}`,
      '.next/server/chunk.js': `x;${pad(70)}${PAYLOAD}`,
      'apps/site/.svelte-kit/output.js': `x;${pad(70)}${PAYLOAD}`,
    });
    const { findings } = await run();
    expect(findings.map((f) => f.file)).toEqual(['a.js']);
    expect(GENERATED_FOLDERS).toContain('.next');
  });

  it('warns about each text file too large to read, naming it', async () => {
    await create(temp, {
      'big.js': `x;${pad(70)}${PAYLOAD}`.padEnd(MAX_TEXT_BYTES + 1, 'a'),
      'video.mp4': Buffer.concat([Buffer.alloc(MAX_TEXT_BYTES + 1)]),
      'small.js': 'ok();',
    });
    const { findings, warnings } = await run();
    expect(findings).toEqual([]);
    expect(warnings).toEqual([
      { file: 'big.js', message: "Skipped: larger than 8 MiB, so the code rules didn't read it." },
    ]);
  });

  it('reads an 8 MiB payload line quickly', async () => {
    await create(temp, {
      'index.js': `module.exports = {};${pad(157, '\t')}eval(${'a'.repeat(MAX_TEXT_BYTES - 1000)})`,
    });
    const started = performance.now();
    const { findings } = await run();
    expect(findings).toEqual([expect.objectContaining({ severity: 'critical', line: 1 })]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("finds nothing in devsweep's own repository, as its CI self-scan requires", async () => {
    const { findings } = await run(REPO);
    expect(findings).toEqual([]);
  });
});

describe('reports of these findings', () => {
  const markers = fixedMarkers().map((m) => m.text);

  async function cli(...argv: string[]) {
    let stdout = '';
    await main([...argv, '--offline'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      color: false,
      interactive: false,
      width: 100,
      env: {},
      fetch: () => Promise.reject(new Error('no network in tests')),
    });
    return stdout;
  }

  it.each([
    ['the terminal, with --details', ['--details']],
    ['--json', ['--json']],
    ['--sarif', ['--sarif']],
  ])('never quote the payload or a marker in %s', async (_name, flags) => {
    await infectedProject();
    await create(temp, { 'lib/a.js': `${pad(70)}${markerOfKind('XOR key')}${PAYLOAD}` });
    const output = await cli(temp, ...flags);
    expect(output).toContain('code/hidden-padding');
    expect(output).toContain('code/known-marker');
    expect(output).not.toContain(CANARY);
    for (const marker of markers) expect(output).not.toContain(marker);
  });

  it('say why the line is not shown in --details', async () => {
    await create(temp, { 'a.js': `a;${pad(70)}${PAYLOAD}` });
    const output = await cli(temp, '--details');
    expect(output.replace(/\s+/g, ' ')).toContain(SOURCE_HIDDEN_NOTE);
  });
});
