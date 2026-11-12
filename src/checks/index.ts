import type { Check } from '../types.js';
import { workflowsCheck } from './workflows/index.js';

export const checks: readonly Check[] = [workflowsCheck];

export const rules = checks.flatMap((check) => check.rules);
