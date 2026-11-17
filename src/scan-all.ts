import path from 'node:path';
import { mapLimit } from './concurrency.js';
import { ConfigError } from './config.js';
import { errorMessage } from './errors.js';
import { assertDirectory, ScanTargetError, scan } from './scanner.js';
import type { Env, ProjectScan, ScanAllResult, ScanResult } from './types.js';
import { findProjects, type ReadDir, toSlashes } from './walk.js';

/** What `--all` is doing, for a progress line. */
export type ScanAllProgress =
  | { stage: 'searching'; folders: number; projects: number }
  | { stage: 'scanning'; done: number; total: number; project: string };

export interface ScanAllOptions {
  /** Folder to search for projects. Relative paths resolve against the current folder. */
  root: string;
  env?: Env | undefined;
  onProgress?: ((progress: ScanAllProgress) => void) | undefined;
}

/** Projects scanned at once. Each scan is quick and mostly waits on the disk. */
const PROJECT_CONCURRENCY = 4;

/**
 * Finds every project under a folder and scans each one with its own devsweep.config.json.
 *
 * Network checks are always skipped, as with --offline: one GitHub API call per check per
 * project would use up the API's hourly limit after a few dozen repositories.
 *
 * Rejects with ScanTargetError when the folder is missing or can't be read. A problem inside one
 * project, such as a broken config file, becomes an error in that project's result instead.
 */
export async function scanAll(options: ScanAllOptions): Promise<ScanAllResult> {
  const started = performance.now();
  const root = path.resolve(options.root);
  await assertDirectory(root);

  let found: Awaited<ReturnType<typeof findProjects>>;
  try {
    found = await findProjects(root, {
      onProgress: (p) => options.onProgress?.({ stage: 'searching', ...p }),
    });
  } catch (error) {
    throw new ScanTargetError(`Couldn't open ${root}: ${errorMessage(error)}`);
  }

  let done = 0;
  const projects = await mapLimit(
    found.projects,
    PROJECT_CONCURRENCY,
    async (dir): Promise<ProjectScan> => {
      const shown = toSlashes(path.relative(root, dir)) || '.';
      options.onProgress?.({
        stage: 'scanning',
        done,
        total: found.projects.length,
        project: shown,
      });
      const result = await scanProject(
        dir,
        nestedIn(dir, found.projects),
        options.env,
        found.readdir,
      );
      done++;
      return { path: shown, result };
    },
  );

  return {
    root,
    projects,
    foldersSearched: found.folders,
    unreadable: found.unreadable,
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * The projects inside `dir`, as paths from `dir` with forward slashes. Each is scanned as its own
 * project, so the scan of `dir` leaves their folders out: otherwise every file in a nested
 * project would be read twice and its findings reported under both projects.
 */
export function nestedIn(dir: string, projects: readonly string[]): string[] {
  // Every path comes from the same search, so a plain prefix test is enough, and far cheaper
  // than path.relative when a drive holds thousands of projects.
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return projects
    .filter((other) => other.startsWith(prefix))
    .map((other) => toSlashes(other.slice(prefix.length)));
}

/** Scans one project. A scan that can't start becomes a result with one error, not a crash. */
async function scanProject(
  root: string,
  skipFolders: readonly string[],
  env: Env | undefined,
  readdir: ReadDir,
): Promise<ScanResult> {
  try {
    return await scan({ root, skipFolders, offline: true, env, readdir });
  } catch (error) {
    return {
      root,
      findings: [],
      accepted: [],
      warnings: [],
      errors: [
        { checkId: error instanceof ConfigError ? 'config' : 'scan', message: errorMessage(error) },
      ],
      durationMs: 0,
    };
  }
}
