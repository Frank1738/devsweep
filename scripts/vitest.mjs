// Starts vitest from its canonical path.
//
// Vitest loads its worker from the path its CLI was started with, but test files import vitest
// from the canonical path. On Windows, a lowercase drive letter (c:\ instead of C:\, which is
// what VS Code terminals often use) turns those into two separate copies of vitest, and every
// test file fails with "Cannot read properties of undefined (reading 'config')".
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const vitestDir = realpathSync.native(path.dirname(require.resolve('vitest/package.json')));

process.chdir(realpathSync.native(process.cwd()));
await import(pathToFileURL(path.join(vitestDir, 'vitest.mjs')).href);
