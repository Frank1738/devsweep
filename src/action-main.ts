import { runAction } from './action.js';
import { runEntryPoint } from './entry-point.js';

// The GitHub Action's entry point (see action.yml). Output is always plain: no color, no animation.
runEntryPoint((io) => runAction(process.env, io), { color: false, interactive: false });
