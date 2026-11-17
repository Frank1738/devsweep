import { createFinding, type Finding, type Rule } from '../../types.js';
import { baseName, forEachLine } from './text.js';

export const propagationScript: Rule = {
  id: 'code/propagation-script',
  title: 'PolinRider propagation script',
  severity: 'critical',
  hidesSource: true,
  description:
    'The PolinRider malware spreads with batch scripts named temp_auto_push.bat and ' +
    'temp_interactive_push.bat: they rewrite git history and force-push the infection to every ' +
    'repository the infected machine can write to. Either file anywhere in a project is ' +
    'critical. A .gitignore line that is exactly config.bat, temp_auto_push.bat or ' +
    "branch_structure.json is medium: it doesn't mean the payload is here, but suggests a " +
    "contributor's machine was infected and pushed to this repository.",
  remediation:
    "Don't run the script. Delete it, and treat the machine that created it as compromised: " +
    'rotate its GitHub tokens and SSH keys from a clean device. Check the repository for force ' +
    "pushes (devsweep's repo/force-push-detected rule does this with a GitHub token) and compare " +
    'recent commits with what their authors remember writing.',
};

/** The scripts themselves. Matched ignoring case, as Windows does. */
const SCRIPTS = new Set(['temp_auto_push.bat', 'temp_interactive_push.bat']);

/** Files the scripts create, which an infected machine adds to .gitignore. */
const IGNORED_ENTRIES = new Set(['config.bat', 'temp_auto_push.bat', 'branch_structure.json']);

export function isScript(file: string): boolean {
  return SCRIPTS.has(baseName(file).toLowerCase());
}

export function isGitignore(file: string): boolean {
  return baseName(file) === '.gitignore';
}

/** A finding for a propagation script, found by its name alone. */
export function scriptFinding(file: string): Finding {
  return createFinding(propagationScript, {
    file,
    // The whole file is the problem. SARIF needs a line, and GitHub shows the alert there.
    at: { line: 1 },
    subject: baseName(file).toLowerCase(),
    message:
      `${baseName(file)} is the name of PolinRider's propagation script, which rewrites git ` +
      'history and force-pushes the infection to every repository the infected machine can ' +
      'write to.',
  });
}

/**
 * Reports each .gitignore line that is exactly one of the files the scripts create. A leading
 * slash, which only anchors the entry to this folder, counts as the same entry.
 */
export function analyzeGitignore(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  forEachLine(text, (line, number) => {
    const entry = line.trimEnd().replace(/^\//, '');
    if (!IGNORED_ENTRIES.has(entry)) return;
    findings.push(
      createFinding(propagationScript, {
        file,
        at: { line: number, column: 1 },
        subject: entry,
        severity: 'medium',
        message:
          `This .gitignore ignores ${entry}, a file PolinRider's propagation script creates. ` +
          "That suggests a contributor's machine was infected and pushed to this repository, " +
          'possibly by rewriting its history. Check for force pushes: devsweep reports them ' +
          'under repo/force-push-detected when it has a GitHub token.',
        remediation:
          'Find the commit that added this line and who pushed it. Ask that contributor to check ' +
          'their machine for PolinRider and rotate their GitHub tokens and SSH keys. Compare ' +
          "the repository's recent history with a copy you trust, then remove the line.",
      }),
    );
  });
  return findings;
}
