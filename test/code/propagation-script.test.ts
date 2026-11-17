import { describe, expect, it } from 'vitest';
import {
  analyzeGitignore,
  isGitignore,
  isScript,
  scriptFinding,
} from '../../src/checks/code/propagation-script.js';

describe('isScript', () => {
  it('matches the two script names anywhere, ignoring case', () => {
    expect(isScript('temp_auto_push.bat')).toBe(true);
    expect(isScript('deep/folder/TEMP_INTERACTIVE_PUSH.BAT')).toBe(true);
    expect(isScript('config.bat')).toBe(false);
    expect(isScript('temp_auto_push.bat.txt')).toBe(false);
    expect(isScript('my_temp_auto_push.bat')).toBe(false);
  });
});

describe('scriptFinding', () => {
  it('is critical, at line 1 of the script', () => {
    expect(scriptFinding('tools/temp_auto_push.bat')).toEqual(
      expect.objectContaining({
        ruleId: 'code/propagation-script',
        severity: 'critical',
        file: 'tools/temp_auto_push.bat',
        line: 1,
        subject: 'temp_auto_push.bat',
        message:
          "temp_auto_push.bat is the name of PolinRider's propagation script, which rewrites git " +
          'history and force-pushes the infection to every repository the infected machine can ' +
          'write to.',
      }),
    );
  });
});

describe('analyzeGitignore', () => {
  it('reports each exact entry as medium, at its line', () => {
    const text =
      'node_modules/\n.env\nconfig.bat\r\n/branch_structure.json\ntemp_auto_push.bat  \n';
    const findings = analyzeGitignore('.gitignore', text);
    expect(findings.map((f) => [f.line, f.column, f.subject, f.severity])).toEqual([
      [3, 1, 'config.bat', 'medium'],
      [4, 1, 'branch_structure.json', 'medium'],
      [5, 1, 'temp_auto_push.bat', 'medium'],
    ]);
    expect(findings[0]?.message).toBe(
      "This .gitignore ignores config.bat, a file PolinRider's propagation script creates. " +
        "That suggests a contributor's machine was infected and pushed to this repository, " +
        'possibly by rewriting its history. Check for force pushes: devsweep reports them under ' +
        'repo/force-push-detected when it has a GitHub token.',
    );
  });

  it('ignores lines that only contain or resemble an entry', () => {
    const text = '# config.bat\nmyconfig.bat\nconfig.bat.bak\n*.bat\n!config.bat\n  config.bat\n';
    expect(analyzeGitignore('.gitignore', text)).toEqual([]);
  });

  it('only reads files named exactly .gitignore', () => {
    expect(isGitignore('.gitignore')).toBe(true);
    expect(isGitignore('packages/web/.gitignore')).toBe(true);
    expect(isGitignore('.gitignore.bak')).toBe(false);
    expect(isGitignore('.dockerignore')).toBe(false);
  });
});
