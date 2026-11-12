import { createRequire } from 'node:module';

// Resolves to the package root from both src/ (tests) and dist/ (published build).
const require = createRequire(import.meta.url);

export const VERSION: string = (require('../package.json') as { version: string }).version;
