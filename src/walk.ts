// The shared folder walker. It finds projects for `--all`, and lists the files inside one
// project for the rules that read every file.
//
// It never follows symbolic links or Windows junctions: a link can point at a parent folder and
// loop forever, and "C:\Documents and Settings" is a junction to C:\Users, so following links
// would also search the same folders twice.

import type { Dirent } from 'node:fs';
import { readdir as fsReaddir } from 'node:fs/promises';
import path from 'node:path';
import { compareText } from './compare.js';

/** Lists a folder. Tests pass their own to simulate folders that can't be opened. */
export type ReadDir = (dir: string) => Promise<Dirent[]>;

/** Never searched, at any depth: installed packages and git's own database. */
const SKIPPED_ANYWHERE = new Set(['node_modules', '.git', 'appdata']);
/**
 * Windows system folders, skipped only directly under a drive root such as C:\. Deeper down
 * these names are ordinary: Flutter projects have their own `windows` folder, for example.
 */
const SKIPPED_AT_DRIVE_ROOT = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
]);

/**
 * What makes a folder a project, as shown to the user. `findProjects` checks for exactly these.
 */
export const PROJECT_MARKERS = ['.git', '.github/workflows', '.vscode/tasks.json'] as const;

/**
 * True when the walker never enters a folder called `name` inside `parent`. Windows ignores
 * case in names, so this does too.
 */
export function isSkippedFolder(name: string, parent: string): boolean {
  const lower = name.toLowerCase();
  if (SKIPPED_ANYWHERE.has(lower)) return true;
  return SKIPPED_AT_DRIVE_ROOT.has(lower) && isDriveRoot(parent);
}

function isDriveRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  return path.parse(resolved).root === resolved;
}

/** How many folders to read at once. Disks answer faster with a few requests in flight. */
const FOLDER_CONCURRENCY = 8;

/**
 * Reads every folder under `root`, calling `visit` with each folder's entries. `visit` returns
 * the subfolders to enter next. Only real folders are entered, never links.
 *
 * Resolves with the folders that couldn't be opened, as absolute paths, sorted. Rejects only when
 * `root` itself can't be read.
 */
function crawl(
  root: string,
  readdir: ReadDir,
  visit: (dir: string, entries: Dirent[]) => string[],
): Promise<string[]> {
  // A list of folders still to read. Taking from the end searches deep first, which keeps the
  // list short: on a whole drive, a breadth-first search would hold every folder at one depth.
  const queue = [root];
  const unreadable: string[] = [];
  let inFlight = 0;

  return new Promise((resolve, reject) => {
    const pump = () => {
      while (inFlight < FOLDER_CONCURRENCY && queue.length > 0) {
        const dir = queue.pop() as string;
        inFlight++;
        readdir(dir)
          .then(
            (entries) => {
              queue.push(...visit(dir, entries));
            },
            (error: unknown) => {
              if (dir === root) throw error;
              unreadable.push(dir);
            },
          )
          .then(() => {
            inFlight--;
            if (inFlight === 0 && queue.length === 0) {
              resolve(unreadable.sort(comparePaths));
            } else {
              pump();
            }
          })
          .catch(reject);
      }
    };
    pump();
  });
}

/**
 * Orders paths by character code, treating both separators as /, so the order is the same on
 * Windows and everywhere else. Unsorted, Windows' \ (code 92) would come after capital
 * letters, where / (code 47) comes before them.
 */
function comparePaths(a: string, b: string): number {
  return compareText(toSlashes(a), toSlashes(b));
}

/** A path with forward slashes, as findings and reports show paths on every system. */
export function toSlashes(file: string): string {
  return file.replaceAll(path.sep, '/');
}

/** Subfolders to enter: real folders only (not links or junctions), minus the skipped ones. */
function subfolders(dir: string, entries: readonly Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory() && !isSkippedFolder(entry.name, dir))
    .map((entry) => path.join(dir, entry.name));
}

function defaultReaddir(dir: string): Promise<Dirent[]> {
  return fsReaddir(dir, { withFileTypes: true });
}

export interface FindProjectsOptions {
  /** Called after each folder is read, to show progress. */
  onProgress?: ((progress: { folders: number; projects: number }) => void) | undefined;
  readdir?: ReadDir | undefined;
}

export interface FoundProjects {
  /** Absolute paths of the projects found, sorted. */
  projects: string[];
  /** How many folders were searched. */
  folders: number;
  /** Folders that couldn't be opened, such as ones without permission. Absolute paths, sorted. */
  unreadable: string[];
  /**
   * Lists the folders in and under projects from what the search already read, so scanning a
   * project doesn't read its folders from the disk again. Each listing is handed out once, then
   * dropped to free memory.
   */
  readdir: ReadDir;
}

/**
 * Finds every project under `root`, including `root` itself: each folder holding one of
 * PROJECT_MARKERS. `.git` may be a folder, or the file git uses for submodules and worktrees.
 * The search carries on inside projects, since a project can hold others.
 */
export async function findProjects(
  root: string,
  options: FindProjectsOptions = {},
): Promise<FoundProjects> {
  const start = path.resolve(root);
  const projects = new Set<string>();
  let folders = 0;
  // Listings kept for scanning: folders that may be projects, and everything under them. A
  // folder is read before its subfolders, so its parent's listing is already here if kept.
  const kept = new Map<string, Dirent[]>();

  const unreadable = await crawl(start, options.readdir ?? defaultReaddir, (dir, entries) => {
    folders++;
    const has = (name: string) => entries.some((entry) => entry.name === name);
    if (has('.git') || has('.github') || has('.vscode') || kept.has(path.dirname(dir))) {
      kept.set(dir, entries);
    }
    if (has('.git')) projects.add(dir);
    // A project's .github and .vscode folders are searched like any other, so they are where
    // their parent is recognised. That needs no extra reads from the disk.
    const name = path.basename(dir);
    if ((name === '.github' && has('workflows')) || (name === '.vscode' && has('tasks.json'))) {
      projects.add(path.dirname(dir));
    }
    options.onProgress?.({ folders, projects: projects.size });
    return subfolders(dir, entries);
  });

  const read = options.readdir ?? defaultReaddir;
  return {
    projects: [...projects].sort(comparePaths),
    folders,
    unreadable,
    readdir: (dir) => {
      const entries = kept.get(dir);
      if (!entries) return read(dir);
      kept.delete(dir);
      return Promise.resolve(entries);
    },
  };
}

export interface ListFilesOptions {
  /**
   * Folders to leave out, as paths from the project root with forward slashes. `--all` passes
   * the projects nested inside this one, since it scans each of those on its own.
   */
  skipFolders?: readonly string[] | undefined;
  /** Folder names never entered, at any depth, compared ignoring case. */
  skipNames?: readonly string[] | undefined;
  /** Called with each file as soon as it is found, so reading can start before listing ends. */
  onFile?: ((file: string) => void) | undefined;
  readdir?: ReadDir | undefined;
}

export interface ListedFiles {
  /** Paths from the project root, with forward slashes, as findings show them. Sorted. */
  files: string[];
  /** Folders that couldn't be opened, as paths from the project root. Sorted. */
  unreadable: string[];
}

/**
 * Lists the files in one project, skipping `node_modules`, the inside of `.git`, links, and the
 * folders in `skipFolders` and `skipNames`. It only reads folders, never files: the caller opens
 * each file once, to read it.
 */
export async function listFiles(
  root: string,
  options: ListFilesOptions = {},
): Promise<ListedFiles> {
  const start = path.resolve(root);
  // Only a drive root such as C:\ ends with a separator after path.resolve.
  const prefix = start.endsWith(path.sep) ? start : start + path.sep;
  const relative = (full: string) => toSlashes(full.slice(prefix.length));
  const skipFolders = new Set(options.skipFolders ?? []);
  const skipNames = new Set((options.skipNames ?? []).map((name) => name.toLowerCase()));
  const entered = (sub: string) =>
    !skipNames.has(path.basename(sub).toLowerCase()) &&
    (skipFolders.size === 0 || !skipFolders.has(relative(sub)));

  const files: string[] = [];
  const unreadable = await crawl(start, options.readdir ?? defaultReaddir, (dir, entries) => {
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = relative(path.join(dir, entry.name));
      files.push(file);
      options.onFile?.(file);
    }
    return subfolders(dir, entries).filter(entered);
  });

  return { files: files.sort(compareText), unreadable: unreadable.map(relative) };
}
