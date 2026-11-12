# devsweep build plan

devsweep is a CLI and GitHub Action that scans a developer's machine and repos for the supply-chain and credential risks that infostealers exploit.

It is built in four phases. Each phase has one job and ends with something that works.

| Phase | Job                                  | Status                               |
| ----- | ------------------------------------ | ------------------------------------ |
| 1     | Core CLI and workflow scanning       | Done (CI green on Linux and Windows) |
| 2     | GitHub integration and first release | Not started                          |
| 3     | Dependency and secret scanning       | Not started                          |
| 4     | Results and launch                   | Not started                          |

---

## Phase 1: Core CLI and workflow scanning

**Job:** a working `devsweep scan` that catches risky GitHub workflows.

- [x] Project setup: TypeScript, tests (vitest), lint (Biome), CI (Linux and Windows, Node 22 and 24)
- [x] Scan engine: `Check`, `Rule` and `Finding` types, and a runner that isolates failing checks
- [x] Output: terminal text and `--json`
- [x] Terminal UI: a gray-gradient "DEVSWEEP" banner over a twinkling starfield, swept in at the top (also on `--help`); one calm line per finding, grouped by file; `--details` for the explanation, code excerpt and fix; a sweep line while slower scans run; `scan` is the default command
- [x] Workflow rules:

| Rule                             | Severity            | Flags                                                                                                                                                                                                                       |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow/untrusted-checkout`    | critical            | A `pull_request_target` workflow that checks out or fetches the pull request's code                                                                                                                                         |
| `workflow/unpinned-action`       | high                | A third-party action, reusable workflow or container image that isn't pinned to a commit SHA or digest                                                                                                                      |
| `workflow/write-all-permissions` | high                | `permissions: write-all` at workflow or job level                                                                                                                                                                           |
| `workflow/pull-request-target`   | medium              | A `pull_request_target` trigger, which runs with secrets and a write token                                                                                                                                                  |
| `workflow/missing-permissions`   | medium              | No top-level `permissions:`, and jobs that don't set their own                                                                                                                                                              |
| `workflow/force-push`            | high, medium or low | A `git push --force`, `-f`, `--force-with-lease`, `--mirror` or `+branch` in a `run:` step, or a push action with `force: true`. High for `main`, `master`, tags and mirrors; medium for other branches; low for `gh-pages` |

**Done when:** scanning a sample repo with bad workflows flags each problem at the right line.

## Phase 2: GitHub integration and first release

**Job:** devsweep runs in CI and its findings appear in GitHub's Security tab.

- [ ] SARIF 2.1.0 output
- [ ] `--fail-on <severity>` and exit codes: 0 clean, 1 findings, 2 tool error
- [ ] A config file for accepting reviewed findings
- [ ] GitHub Action wrapper
- [ ] devsweep scans its own repo in CI
- [x] License: MIT
- [ ] Publish 0.1.0 to npm with provenance
- [ ] Decide whether to bundle runtime dependencies so the package installs with zero dependencies
- [ ] Repository checks through the GitHub API. These are devsweep's first network checks: they run only when a GitHub token is available, and `--offline` skips them.
  - [ ] `repo/force-push-allowed`: the default branch or release tags aren't protected against force pushes (read from rulesets). Reading classic branch protection needs admin access, so without it devsweep reports "couldn't check" rather than guessing.
  - [ ] `repo/force-push-detected`: force pushes to the default branch or tags in recent history (read from the repository activity API). Answers "did someone rewrite history with a stolen token?"

**Done when:** a PR that adds a bad workflow shows up as an alert in the Security tab.

This phase comes before the remaining checks so that every check added later shows up in GitHub automatically.

## Phase 3: Dependency and secret scanning

**Job:** finish the MVP's checks.

- [ ] Shared file walker (skips `node_modules`, `.git`, binary and very large files)
- [ ] Dependencies: packages that run install scripts (read from `package-lock.json` `hasInstallScript`), with an allowlist for known-legit ones
- [ ] Dependencies: look-alike package names, by edit distance against a bundled snapshot of top npm packages
- [ ] Secrets: known token formats in the working tree, `.env`, `.npmrc` and `.git-credentials`
- [ ] Secrets: higher severity when the file is tracked by git
- [ ] Secrets: always redacted in every output format

**Done when:** all MVP checks pass their tests, and a few real repos don't trigger a flood of false alarms.

## Phase 4: Results and launch

**Job:** publish v1.0 with proof that it works.

- [ ] Benchmarks: scan time on a large monorepo, and the false-positive rate across popular open-source repos (totals only)
- [ ] README: pitch, demo GIF, architecture diagram, quickstart under 5 minutes, Decisions & tradeoffs, Results
- [ ] v1.0.0 on npm and the Action on the GitHub Marketplace
- [ ] Walkthrough video

**Done when:** all of the above ships.

## Later (optional)

- `devsweep fix`: pin actions to commit SHAs automatically
- Scan git history for secrets
- Report unsigned commits
- Audit installed VS Code extensions
- Flag dependency versions published less than 72 hours ago

---

## Decisions so far

Collected here as they're made, for the README's Decisions & tradeoffs section.

- **Few, small dependencies.** A supply-chain tool should practise what it checks. Runtime dependencies are `commander`, `yaml` and `picocolors`, and none of them has dependencies of its own.
- **Install scripts are off for this repo** (`ignore-scripts=true` in `.npmrc`), and versions are saved exactly.
- **GitHub-owned actions (`actions/*`, `github/*`) are not flagged as unpinned.** They carry much less risk than third-party actions, and flagging them would bury real findings in noise. devsweep's own CI pins them anyway.
- **`pull_request_target` gets two rules.** The trigger alone is medium. Checking out the PR's code under it is critical, because that runs untrusted code with secrets and a write token. A workflow gets one or the other, never both.
- **Exact line numbers come from the YAML AST**, not from regex over raw text, so findings point at the exact key and SARIF annotations land on the right line. Inside `run: |` scripts, findings point at the exact line of the command.
- **Force-push severity depends on the target.** Rewriting `main` or moving a release tag is how a stolen token hides changes (moved tags were the core of the tj-actions/changed-files attack in March 2025). Force-pushing `gh-pages` is routine for publishing a site.
- **Findings describe commands instead of quoting them.** A push URL can contain a hardcoded token, and findings end up in CI logs and SARIF files.
- **The terminal UI uses no extra libraries.** The layout and animation are about 300 lines using plain ANSI escape codes, which keeps the dependency count at three. Output stays calm by default (one line per finding), with the full explanation behind `--details`.
- **Animation only when a person is watching.** It runs only in an interactive terminal (not in CI, pipes or `--json`), always restores the cursor (including on Ctrl+C), and adds about a third of a second. The scan runs while the banner draws, and the sweep line is skipped when the scan has already finished. Animations are timed by the clock, not by frame counts, because Windows timers tick every ~15.6 ms and frame-counted animations ran twice as long there.
