import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepository } from '../src/git.js';

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-git-'));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('findRepository', () => {
  it('finds the repository from a subfolder, with the path down to it', async () => {
    const repo = path.join(temp, 'repo');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await mkdir(path.join(repo, 'tools', 'ci'), { recursive: true });
    expect(await findRepository(path.join(repo, 'tools', 'ci'))).toEqual({
      root: repo,
      pathFromRoot: 'tools/ci',
    });
  });

  it('returns an empty path at the top of the repository', async () => {
    await mkdir(path.join(temp, '.git'));
    expect(await findRepository(temp)).toEqual({ root: temp, pathFromRoot: '' });
  });

  it('accepts a .git file, as worktrees and submodules have', async () => {
    await writeFile(path.join(temp, '.git'), 'gitdir: ../main/.git/worktrees/feature\n');
    await mkdir(path.join(temp, 'src'));
    expect(await findRepository(path.join(temp, 'src'))).toEqual({
      root: temp,
      pathFromRoot: 'src',
    });
  });
});
