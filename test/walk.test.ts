import type { Dirent } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjects, isSkippedFolder, listFiles } from '../src/walk.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-walk-'));
});

afterEach(async () => {
  // A test may have taken away read permission; give it back so the folder can be deleted.
  await chmod(tmp, 0o755).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
});

/** Creates files under the temp folder. Paths ending in "/" are empty folders. */
async function tree(paths: readonly string[], content: string | Buffer = ''): Promise<void> {
  for (const file of paths) {
    const full = path.join(tmp, file);
    if (file.endsWith('/')) {
      await mkdir(full, { recursive: true });
    } else {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  }
}

/** Project paths relative to the temp folder, with forward slashes. */
function relative(projects: readonly string[]): string[] {
  return projects.map((p) => path.relative(tmp, p).split(path.sep).join('/') || '.');
}

/**
 * Makes a link to a folder. Windows junctions need no special permission, unlike symbolic links;
 * elsewhere a plain symbolic link is used. Returns false where the system refuses both.
 */
async function linkFolder(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('findProjects', () => {
  it('finds folders with .git, .github/workflows or .vscode/tasks.json, including nested ones', async () => {
    await tree([
      'app/.git/HEAD',
      'app/packages/ui/.vscode/tasks.json',
      'app/packages/ui/src/index.js',
      'tools/.github/workflows/ci.yml',
      'submodule-like/.git', // a .git file, as in submodules and worktrees
      'not-a-project/.github/ISSUE_TEMPLATE/bug.md',
      'not-a-project/.vscode/settings.json',
      'plain/readme.txt',
    ]);

    const found = await findProjects(tmp);
    expect(relative(found.projects)).toEqual(['app', 'app/packages/ui', 'submodule-like', 'tools']);
    expect(found.unreadable).toEqual([]);
  });

  it('counts the folder itself when it is a project', async () => {
    await tree(['.github/workflows/ci.yml']);
    expect(relative((await findProjects(tmp)).projects)).toEqual(['.']);
  });

  it('never searches node_modules, the inside of .git, or AppData', async () => {
    await tree([
      'app/.git/HEAD',
      'app/node_modules/dep/.github/workflows/ci.yml',
      'app/.git/modules/inner/.vscode/tasks.json',
      'Node_Modules/dep/.git/HEAD',
      'me/AppData/Roaming/Code/.git/HEAD',
    ]);
    expect(relative((await findProjects(tmp)).projects)).toEqual(['app']);
  });

  it('skips Windows system folders only at a drive root', () => {
    // C:\ is a drive root only on Windows; elsewhere it's an ordinary folder name.
    const roots = process.platform === 'win32' ? ['C:\\', 'D:\\'] : ['/'];
    for (const root of [path.parse(process.cwd()).root, ...roots]) {
      expect(isSkippedFolder('Windows', root)).toBe(true);
      expect(isSkippedFolder('Program Files', root)).toBe(true);
      expect(isSkippedFolder('program files (x86)', root)).toBe(true);
      expect(isSkippedFolder('ProgramData', root)).toBe(true);
      expect(isSkippedFolder('$Recycle.Bin', root)).toBe(true);
      expect(isSkippedFolder('System Volume Information', root)).toBe(true);
      expect(isSkippedFolder('Users', root)).toBe(false);
    }
    // Deeper down they are ordinary names: Flutter projects have a "windows" folder.
    expect(isSkippedFolder('windows', path.join(tmp, 'my_flutter_app'))).toBe(false);
    expect(isSkippedFolder('AppData', path.join(tmp, 'me'))).toBe(true);
    expect(isSkippedFolder('node_modules', path.join(tmp, 'a', 'b'))).toBe(true);
  });

  it('never follows links, so a link back to a parent folder cannot loop forever', async (ctx) => {
    await tree(['outside/.git/HEAD', 'root/app/.git/HEAD']);
    const root = path.join(tmp, 'root');
    const madeLoop = await linkFolder(root, path.join(root, 'app', 'loop'));
    const madeOut = await linkFolder(path.join(tmp, 'outside'), path.join(root, 'linked'));
    if (!madeLoop || !madeOut) ctx.skip();

    const found = await findProjects(root);
    expect(relative(found.projects)).toEqual(['root/app']);
    // root, root/app: the links are neither searched nor counted as folders.
    expect(found.folders).toBe(2);
  });

  it('skips and counts folders that cannot be opened, without crashing', async () => {
    await tree(['ok/.git/HEAD', 'locked/inner/.git/HEAD', 'also-locked/']);
    const locked = new Set([path.join(tmp, 'locked'), path.join(tmp, 'also-locked')]);
    const fakeReaddir = (dir: string): Promise<Dirent[]> => {
      if (locked.has(dir)) {
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        );
      }
      return readdir(dir, { withFileTypes: true });
    };

    const found = await findProjects(tmp, { readdir: fakeReaddir });
    expect(relative(found.projects)).toEqual(['ok']);
    expect(found.unreadable).toEqual([path.join(tmp, 'also-locked'), path.join(tmp, 'locked')]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips a folder without read permission on a real disk',
    async () => {
      await tree(['ok/.git/HEAD', 'locked/inner/.git/HEAD']);
      await chmod(path.join(tmp, 'locked'), 0o000);
      try {
        const found = await findProjects(tmp);
        expect(relative(found.projects)).toEqual(['ok']);
        expect(found.unreadable).toEqual([path.join(tmp, 'locked')]);
      } finally {
        await chmod(path.join(tmp, 'locked'), 0o755);
      }
    },
  );

  it('rejects when the starting folder itself cannot be read', async () => {
    await expect(findProjects(path.join(tmp, 'missing'))).rejects.toThrow();
  });

  it('returns projects in the same order on every run, by character code', async () => {
    // Windows ignores case in names, so no two of these differ only by case.
    const names = [
      'b',
      'Apple',
      'apple2',
      'B10',
      'B2',
      'é',
      '_x',
      'apple2/nested',
      'apple2-x',
      'apple2Z',
    ];
    await tree(names.map((name) => `${name}/.git/HEAD`));

    const first = relative((await findProjects(tmp)).projects);
    expect(first).toEqual([
      'Apple',
      'B10',
      'B2',
      '_x',
      'apple2',
      'apple2-x',
      'apple2/nested',
      'apple2Z',
      'b',
      'é',
    ]);
    for (let i = 0; i < 5; i++) expect(relative((await findProjects(tmp)).projects)).toEqual(first);
  });

  it('reports progress as it searches', async () => {
    await tree(['a/.git/HEAD', 'b/c/']);
    const seen: { folders: number; projects: number }[] = [];
    await findProjects(tmp, { onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)).toEqual({ folders: 4, projects: 1 });
  });
});

describe('findProjects listings', () => {
  it('hands its listings to the scan, so no folder in a project is read from disk twice', async () => {
    await tree(['app/.git/HEAD', 'app/src/a.js', 'app/src/deep/b.js', 'notes/todo.txt']);
    const reads: string[] = [];
    const counting = (dir: string) => {
      reads.push(dir);
      return readdir(dir, { withFileTypes: true });
    };
    const found = await findProjects(tmp, { readdir: counting });
    const searched = reads.length;
    const listed = await listFiles(path.join(tmp, 'app'), { readdir: found.readdir });
    expect(listed.files).toEqual(['src/a.js', 'src/deep/b.js']);
    expect(reads.length).toBe(searched);
  });
});

describe('listFiles', () => {
  it('lists files by path from the project root, sorted, skipping node_modules and .git', async () => {
    await tree([
      'src/b.js',
      'src/a.js',
      'README.md',
      'node_modules/dep/index.js',
      '.git/config',
      '.github/workflows/ci.yml',
    ]);
    await tree(['logo.png'], Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const listed = await listFiles(tmp);
    expect(listed.files).toEqual([
      '.github/workflows/ci.yml',
      'README.md',
      'logo.png',
      'src/a.js',
      'src/b.js',
    ]);
  });

  it('leaves out the folders in skipFolders, by path from the project root', async () => {
    await tree(['a.js', 'apps/web/b.js', 'apps/web/deep/c.js', 'apps/api/d.js', 'web/e.js']);
    const listed = await listFiles(tmp, { skipFolders: ['apps/web'] });
    expect(listed.files).toEqual(['a.js', 'apps/api/d.js', 'web/e.js']);
  });

  it('leaves out folders named in skipNames at any depth, ignoring case', async () => {
    await tree(['a.js', '.next/b.js', 'apps/web/.NEXT/c.js', 'apps/web/next/d.js']);
    const listed = await listFiles(tmp, { skipNames: ['.next'] });
    expect(listed.files).toEqual(['a.js', 'apps/web/next/d.js']);
  });

  it('never lists linked files or follows linked folders', async (ctx) => {
    await tree(['outside/secret.txt', 'project/a.txt']);
    const project = path.join(tmp, 'project');
    if (!(await linkFolder(path.join(tmp, 'outside'), path.join(project, 'linked')))) ctx.skip();
    if (!(await linkFolder(project, path.join(project, 'loop')))) ctx.skip();

    const listed = await listFiles(project);
    expect(listed.files).toEqual(['a.txt']);
  });

  it('records folders that cannot be opened, by path from the project root', async () => {
    await tree(['a.txt', 'private/key.txt']);
    const listed = await listFiles(tmp, {
      readdir: (dir) =>
        dir === path.join(tmp, 'private')
          ? Promise.reject(new Error('EPERM'))
          : readdir(dir, { withFileTypes: true }),
    });
    expect(listed.files).toEqual(['a.txt']);
    expect(listed.unreadable).toEqual(['private']);
  });
});
