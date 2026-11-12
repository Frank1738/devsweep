import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepository } from '../git.js';
import type { Env } from '../types.js';

export interface RepositoryRef {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * Which GitHub repository the scan is about: the github.com origin remote of the git repository
 * that contains `root`, or else GITHUB_REPOSITORY. The remote comes first because a workflow can
 * check out and scan a different repository than the one it runs in, which is what
 * GITHUB_REPOSITORY names. On GitHub Enterprise Server the remote isn't on github.com, so there
 * GITHUB_REPOSITORY is used.
 */
export async function findGitHubRepository(
  root: string,
  env: Env,
): Promise<RepositoryRef | undefined> {
  const url = await originUrl(root);
  const fromRemote = url === undefined ? undefined : parseRemoteUrl(url);
  return fromRemote ?? parseSlug(env.GITHUB_REPOSITORY);
}

function parseSlug(value: string | undefined): RepositoryRef | undefined {
  const [owner, repo, ...rest] = (value ?? '').split('/');
  if (!owner || !repo || rest.length > 0 || !NAME.test(owner) || !NAME.test(repo)) {
    return undefined;
  }
  return { owner, repo };
}

/**
 * Reads owner and repo from a github.com remote URL in any of git's forms. The URL itself is never
 * shown anywhere, because an HTTPS remote can contain a token.
 */
export function parseRemoteUrl(url: string): RepositoryRef | undefined {
  let host: string;
  let pathname: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url.trim());
  if (scp?.[1] && scp[2] && !url.includes('://')) {
    host = scp[1];
    pathname = scp[2];
  } else {
    try {
      const parsed = new URL(url.trim());
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  if (!GITHUB_HOSTS.has(host.toLowerCase())) return undefined;
  return parseSlug(
    pathname
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/, ''),
  );
}

/** The origin remote's URL from the repository's git config, without running git. */
async function originUrl(root: string): Promise<string | undefined> {
  const repository = await findRepository(root);
  if (!repository) return undefined;
  const config = await readGitConfig(path.join(repository.root, '.git'));
  return config === undefined ? undefined : remoteUrl(config, 'origin');
}

/** `.git` is a folder in a normal clone, and a file pointing elsewhere in worktrees and submodules. */
async function readGitConfig(dotGit: string): Promise<string | undefined> {
  let gitDir = dotGit;
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'));
    if (pointer?.[1]) gitDir = path.resolve(path.dirname(dotGit), pointer[1].trim());
  } catch {
    // A folder: the config is inside it.
  }
  try {
    const common = (await readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    gitDir = path.resolve(gitDir, common);
  } catch {
    // Not a worktree.
  }
  try {
    return await readFile(path.join(gitDir, 'config'), 'utf8');
  } catch {
    return undefined;
  }
}

/** Finds `url` in a `[remote "<name>"]` section of a git config file. */
export function remoteUrl(config: string, name: string): string | undefined {
  let inSection = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\s\]]+)(?:\s+"(.*)")?\s*\]$/.exec(line);
    if (section) {
      inSection = section[1]?.toLowerCase() === 'remote' && section[2] === name;
      continue;
    }
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (inSection && entry?.[1]) return entry[1].replace(/^"(.*)"$/, '$1').trim();
  }
  return undefined;
}
