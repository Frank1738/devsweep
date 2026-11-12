# devsweep

Scan your dev setup and repos for the supply-chain and credential risks that infostealers exploit.

> **Status:** early development. Workflow scanning works, and GitHub integration (SARIF output and a GitHub Action) is under way.

## Usage

```sh
npm install
npm run build
node dist/bin.js [path]                  # scan a folder (default: the current one)
node dist/bin.js [path] --details        # explain each finding, with the code and the fix
node dist/bin.js [path] --json           # machine-readable output
node dist/bin.js [path] --sarif          # SARIF 2.1.0, the format GitHub's Security tab reads
node dist/bin.js [path] --sarif -o FILE  # save the report to FILE, and show the readable one
```

`-o`/`--output` works with `--json` and `--sarif`. It creates missing folders, and the terminal (or CI log) still lists the findings.

Example output:

```text
  devsweep  test/fixtures/vulnerable-repo

  .github/workflows/pr-preview.yml
    ● critical  14  Runs pull request code with secrets   job preview
    ● high      16  Unpinned action                       example-org/deploy-preview@v2
    ● medium     9  Token permissions not limited         job preview

  .github/workflows/docs.yml
    ● low       16  Force push                            branch gh-pages

  4 issues  1 critical  1 high  1 medium  1 low  · 21 ms
  Add --details to see why each one matters and how to fix it.
```

In a terminal, devsweep opens with a gradient banner that sweeps in, and shows a sweep line if the scan takes a moment. In CI, or when output is piped, the output is plain text with no animation.

## What it checks

| Rule                             | Severity            | Flags                                                                                                                    |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `workflow/untrusted-checkout`    | critical            | A `pull_request_target` workflow that checks out or fetches the pull request's code                                      |
| `workflow/unpinned-action`       | high                | A third-party action, reusable workflow or container image that isn't pinned to a commit SHA or digest                   |
| `workflow/write-all-permissions` | high                | `permissions: write-all` at workflow or job level                                                                        |
| `workflow/pull-request-target`   | medium              | A `pull_request_target` trigger, which runs with secrets and a write token                                               |
| `workflow/missing-permissions`   | medium              | No top-level `permissions:`, and jobs that don't set their own                                                           |
| `workflow/force-push`            | high, medium or low | A workflow that force-pushes. High for `main`, `master`, tags and mirrors; medium for other branches; low for `gh-pages` |

Checks for whether force pushes are allowed on the default branch and tags, and whether any happened recently, come in Phase 2. Dependency and secret checks come in Phase 3.

### SARIF output

`--sarif` writes [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html) in the subset that [GitHub code scanning](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning) reads. Each finding's severity maps to a SARIF level and to the score GitHub uses for the alert's severity:

| devsweep | SARIF level | GitHub security severity |
| -------- | ----------- | ------------------------ |
| critical | `error`     | 9.5 (critical)           |
| high     | `error`     | 8.0 (high)               |
| medium   | `warning`   | 5.5 (medium)             |
| low      | `note`      | 2.0 (low)                |

File paths are relative to the repository root, even when you scan a subfolder. The report contains no timestamps or absolute paths, so it's safe to share. Skipped files and failed checks are listed under `invocations`.

## Development

Requires Node 22.12 or later.

```sh
npm test            # vitest
npm run lint        # Biome
npm run typecheck   # tsc
```

`test/fixtures/vulnerable-repo` is a sample repository with one of each problem planted in it.

## License

[MIT](LICENSE)
