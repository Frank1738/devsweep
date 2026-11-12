// Bundles devsweep and its runtime dependencies into self-contained files:
//
//   action/main.mjs     the GitHub Action. Committed, and CI fails if it differs from a fresh build.
//   dist/devsweep.mjs   the npm package's command.
//   dist/index.mjs      the npm package's library entry.
//
// Each file includes the license text of every package bundled into it, as their licenses require.
// The output is not minified, so anyone can read exactly what runs.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const entries = [
  { input: 'src/action-main.ts', file: 'action/main.mjs' },
  { input: 'src/bin.ts', file: 'dist/devsweep.mjs' },
  { input: 'src/index.ts', file: 'dist/index.mjs' },
];

for (const entry of entries) {
  const { output } = await build({
    input: entry.input,
    platform: 'node',
    logLevel: 'warn',
    output: { file: entry.file, format: 'esm', codeSplitting: false },
  });
  const [chunk] = output;
  if (chunk?.type !== 'chunk') throw new Error(`no output for ${entry.input}`);
  const notices = await licenseNotices(chunk.moduleIds);
  await writeFile(entry.file, `${chunk.code.replace(/\n*$/, '\n')}${notices}`, 'utf8');
  console.log(`${entry.file}  ${Math.round(Buffer.byteLength(chunk.code) / 1024)} KB`);
}

/** A comment listing each bundled package with its license text, in a stable order. */
async function licenseNotices(moduleIds) {
  // Keyed by folder, because a package nested in another's node_modules can be another version.
  const packages = new Map();
  for (const id of moduleIds) {
    // The greedy start finds the last node_modules, so node_modules/a/node_modules/b/x.js is b's.
    const match = /^(.*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+))[\\/]/.exec(id);
    if (match) packages.set(path.resolve(match[1]), match[2].replaceAll('\\', '/'));
  }
  if (packages.size === 0) return '';

  const byName = [...packages]
    .map(([dir, name]) => ({ dir, name }))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.dir, b.dir));
  const sections = [];
  for (const { dir, name } of byName) {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    const license = await readLicense(dir);
    sections.push(`${name}@${pkg.version} (${pkg.license})\n\n${license.trim()}`);
  }
  const body = sections.join('\n\n---\n\n').replaceAll('*/', '* /');
  return `\n/*\nBundled third-party packages and their licenses:\n\n${body}\n*/\n`;
}

function compareText(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

async function readLicense(dir) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    try {
      return (await readFile(path.join(dir, name), 'utf8')).replaceAll('\r\n', '\n');
    } catch {}
  }
  throw new Error(`no license file in ${dir}`);
}
