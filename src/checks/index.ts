import type { Check } from '../types.js';
import { repoCheck } from './repo/index.js';
import { workflowsCheck } from './workflows/index.js';

export const checks: readonly Check[] = [workflowsCheck, repoCheck];

export const rules = checks.flatMap((check) => check.rules);
