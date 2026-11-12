import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface Repository {
  /** Absolute path of the repository's top folder. */
  root: string;
  /** Path from `root` to the folder that was searched from, with forward slashes. '' at the top. */
  pathFromRoot: string;
}

/**
 * Finds the git repository that contains `dir`, by walking up to the nearest `.git`. That is a
 * folder in a normal clone and a file in worktrees and submodules. Reads the file system only;
 * it never runs git. Returns undefined outside a repository.
 */
export async function findRepository(dir: string): Promise<Repository | undefined> {
  const below: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    if (await exists(path.join(current, '.git'))) {
      return { root: current, pathFromRoot: below.reverse().join('/') };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    below.push(path.basename(current));
    current = parent;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
