import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findGitHubRepository, parseRemoteUrl, remoteUrl } from '../src/github/repository.js';

const demo = { owner: 'octo', repo: 'demo' };

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/octo/demo.git', demo],
    ['https://github.com/octo/demo', demo],
    ['https://github.com/octo/demo/', demo],
    ['https://x-access-token:ghs_abc@github.com/octo/demo.git', demo],
    ['git@github.com:octo/demo.git', demo],
    ['ssh://git@github.com/octo/demo.git', demo],
    ['ssh://git@ssh.github.com:443/octo/demo.git', demo],
    ['git://github.com/octo/demo.git', demo],
    ['https://gitlab.com/octo/demo.git', undefined],
    ['git@bitbucket.org:octo/demo.git', undefined],
    ['https://github.com/octo', undefined],
    ['C:/repos/demo', undefined],
    ['not a url', undefined],
  ])('reads %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });
});

describe('remoteUrl', () => {
  it('finds the url in the named remote section only', () => {
    const config = [
      '[core]',
      '\tbare = false',
      '[remote "upstream"]',
      '\turl = https://github.com/other/fork.git',
      '[remote "origin"]',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '\turl = git@github.com:octo/demo.git',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\r\n');
    expect(remoteUrl(config, 'origin')).toBe('git@github.com:octo/demo.git');
    expect(remoteUrl(config, 'missing')).toBeUndefined();
  });
});

describe('findGitHubRepository', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'devsweep-remote-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  /** A clone with the given origin remote, or none. Returns a subfolder of it. */
  async function cloneWithOrigin(url: string | undefined): Promise<string> {
    await mkdir(path.join(temp, '.git'), { recursive: true });
    const config = url === undefined ? '[core]\n' : `[remote "origin"]\n\turl = ${url}\n`;
    await writeFile(path.join(temp, '.git', 'config'), config);
    await mkdir(path.join(temp, 'sub'), { recursive: true });
    return path.join(temp, 'sub');
  }

  it('reads the origin remote, from a subfolder of the clone', async () => {
    const root = await cloneWithOrigin('git@github.com:octo/demo.git');
    expect(await findGitHubRepository(root, {})).toEqual(demo);
  });

  it("prefers the scanned clone's origin over GITHUB_REPOSITORY, the workflow's own repository", async () => {
    const root = await cloneWithOrigin('https://github.com/octo/demo.git');
    expect(await findGitHubRepository(root, { GITHUB_REPOSITORY: 'other/workflow-repo' })).toEqual(
      demo,
    );
  });

  it.each([
    ['is not on github.com, as on GitHub Enterprise Server', 'https://ghe.example.com/x/y.git'],
    ['is missing', undefined],
  ])('falls back to GITHUB_REPOSITORY when the origin remote %s', async (_, url) => {
    const root = await cloneWithOrigin(url);
    expect(await findGitHubRepository(root, { GITHUB_REPOSITORY: 'octo/demo' })).toEqual(demo);
  });

  it('ignores a malformed GITHUB_REPOSITORY', async () => {
    const root = await cloneWithOrigin(undefined);
    expect(await findGitHubRepository(root, { GITHUB_REPOSITORY: 'octo' })).toBeUndefined();
  });

  it('follows a worktree .git file to the shared config', async () => {
    const main = path.join(temp, 'main');
    await mkdir(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    await writeFile(
      path.join(main, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/octo/demo\n',
    );
    await writeFile(path.join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const worktree = path.join(temp, 'feature');
    await mkdir(worktree);
    await writeFile(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`,
    );
    expect(await findGitHubRepository(worktree, {})).toEqual(demo);
  });

  it('returns nothing for a remote that is not on GitHub', async () => {
    const root = await cloneWithOrigin('https://gitlab.com/octo/demo.git');
    expect(await findGitHubRepository(root, {})).toBeUndefined();
  });
});
