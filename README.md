# devsweep

Scan your dev setup and repos for the supply-chain and credential risks that infostealers exploit.

> **Status:** early development (0.x). Workflow and repository-settings checks work, with SARIF output and a GitHub Action. Dependency and secret checks are next.

## Usage

Requires Node 22.12 or later.

```sh
npx devsweep [path]                  # scan a folder (default: the current one)
npx devsweep [path] --details        # explain each finding, with the code and the fix
npx devsweep [path] --json           # machine-readable output
npx devsweep [path] --sarif          # SARIF 2.1.0, the format GitHub's Security tab reads
npx devsweep [path] --sarif -o FILE  # save the report to FILE, and show the readable one
npx devsweep [path] --fail-on high   # fail only on high or critical findings
npx devsweep [path] --offline        # skip the checks that call the GitHub API
```

The npm package has no dependencies: devsweep and the three libraries it uses are bundled into one readable file. Every release is published from GitHub Actions with [provenance](https://docs.npmjs.com/generating-provenance-statements), so `npm audit signatures` can confirm it was built from this repository.

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

### Exit codes

| Code | Meaning                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| 0    | Nothing found at or above the `--fail-on` severity                                                                         |
| 1    | Findings at or above the `--fail-on` severity                                                                              |
| 2    | devsweep couldn't do its job: a bad option, a path that can't be scanned, a report that can't be saved, or a check crashed |

`--fail-on` takes `critical`, `high`, `medium`, `low` or `none`. The default is `low`, so any finding fails the run; `none` never fails on findings. A crashed check gives 2 even when there are findings, because the results are incomplete. Files skipped as invalid YAML are listed but don't change the exit code.

### Accepting reviewed findings

When you've reviewed a finding and decided to keep it, record that in `devsweep.config.json` in the folder you scan:

```json
{
  "accept": [
    {
      "rule": "workflow/pull-request-target",
      "file": ".github/workflows/label.yml",
      "reason": "Only adds labels; it never checks out or runs pull request code."
    },
    {
      "rule": "workflow/unpinned-action",
      "file": ".github/workflows/ci.yml",
      "subject": "example-org/setup-tool@v3",
      "reason": "Our own action, released from a protected tag."
    }
  ],
  "rules": {
    "workflow/missing-permissions": { "severity": "low" }
  }
}
```

- An acceptance matches on `rule`, `file` and `subject`, never on line numbers, which move. `subject` is the text shown after the title in the findings list (run with `--json` to see it exactly). Leave it out only for findings that have none.
- Every acceptance needs a `reason`. Accepted findings drop out of the list and don't fail the run, but the summary counts them (`2 accepted`).
- An acceptance that no longer matches anything shows up as a warning, so stale exceptions get cleaned up.
- `rules` changes a rule's severity. That affects `--fail-on` and every output format.
- Mistakes such as invalid JSON, an unknown rule, an unknown key or a missing reason stop the scan with exit code 2 and a message naming the problem.

In SARIF, accepted findings are kept with a `suppressions` entry that carries the reason. GitHub code scanning doesn't act on suppressions, so they still appear as open alerts there. Dismiss them in the Security tab with the same reason.

Treat this file like code: it switches checks off. A [`CODEOWNERS`](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) entry for it makes sure every new exception gets reviewed.

## What it checks

| Rule                             | Severity            | Flags                                                                                                                    |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `workflow/untrusted-checkout`    | critical            | A `pull_request_target` workflow that checks out or fetches the pull request's code                                      |
| `workflow/unpinned-action`       | high                | A third-party action, reusable workflow or container image that isn't pinned to a commit SHA or digest                   |
| `workflow/write-all-permissions` | high                | `permissions: write-all` at workflow or job level                                                                        |
| `workflow/pull-request-target`   | medium              | A `pull_request_target` trigger, which runs with secrets and a write token                                               |
| `workflow/missing-permissions`   | medium              | No top-level `permissions:`, and jobs that don't set their own                                                           |
| `workflow/force-push`            | high, medium or low | A workflow that force-pushes. High for `main`, `master`, tags and mirrors; medium for other branches; low for `gh-pages` |
| `repo/force-push-allowed`        | high                | The default branch or release tags aren't protected against force pushes or being moved (read from rulesets)             |
| `repo/force-push-detected`       | high                | A force push to the default branch in the last 90 days (read from the repository activity log)                           |

Dependency and secret checks are coming next.

### GitHub repository checks

The `repo/*` rules read the repository's settings through the GitHub REST API. They are devsweep's only network calls, and `--offline` skips them.

- **Which repository:** the `origin` remote of the git repository you scan, if it's on github.com. Otherwise `GITHUB_REPOSITORY`, which GitHub Actions sets to the repository the workflow runs in (this is how GitHub Enterprise Server repositories are found).
- **Token:** read only from the `GITHUB_TOKEN` or `GH_TOKEN` environment variable. There is deliberately no `--token` flag, because command lines end up in shell history and process lists. Locally, `GH_TOKEN=$(gh auth token) devsweep` works if you use the GitHub CLI. The token is never printed.
- **When they can't run** (no token, no GitHub remote, not enough access, GitHub unreachable or rate-limited), devsweep prints a "couldn't check" warning. That is never a finding, and it doesn't change the exit code.
- Every request times out after 10 seconds.

| What devsweep reads                            | Endpoint                                 | Fine-grained token permission | Workflow `GITHUB_TOKEN`                             |
| ---------------------------------------------- | ---------------------------------------- | ----------------------------- | --------------------------------------------------- |
| Default branch, tags                           | `GET /repos/{o}/{r}`, `.../tags`         | Metadata: read                | Always allowed                                      |
| Rulesets on the default branch and on tags     | `.../rules/branches/{b}`, `.../rulesets` | Metadata: read                | Always allowed                                      |
| Whether the branch has classic protection      | `.../branches/{b}`                       | Contents: read                | `contents: read`                                    |
| Whether classic protection allows force pushes | `.../branches/{b}/protection`            | Administration: read          | Not available, so devsweep reports "couldn't check" |
| Force pushes in the last 90 days               | `.../activity?activity_type=force_push`  | Contents: read                | `contents: read`                                    |

Use rulesets rather than classic branch protection: anyone with read access can see rulesets, while classic protection settings need admin access. GitHub's activity log records force pushes to branches only, so a moved tag can't be detected after the fact. `repo/force-push-allowed` catches tags that can be moved.

### SARIF output

`--sarif` writes [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html) in the subset that [GitHub code scanning](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning) reads. Each finding's severity maps to a SARIF level and to the score GitHub uses for the alert's severity:

| devsweep | SARIF level | GitHub security severity |
| -------- | ----------- | ------------------------ |
| critical | `error`     | 9.5 (critical)           |
| high     | `error`     | 8.0 (high)               |
| medium   | `warning`   | 5.5 (medium)             |
| low      | `note`      | 2.0 (low)                |

File paths are relative to the repository root, even when you scan a subfolder. The report contains no timestamps or absolute paths, so it's safe to share. Skipped files and failed checks are listed under `invocations`.

## GitHub Action

devsweep runs as a GitHub Action and writes SARIF that GitHub's code scanning shows in the Security tab and on pull requests:

```yaml
name: devsweep

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  devsweep:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # to upload results to code scanning
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Scan with devsweep
        id: devsweep
        uses: Frank1738/devsweep@<full-commit-sha> # v0.1.0
        env:
          GITHUB_TOKEN: ${{ github.token }} # enables the repository checks
        with:
          fail-on: high
      - name: Upload results to code scanning
        if: ${{ !cancelled() && steps.devsweep.outputs.sarif-file != '' }}
        uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        with:
          sarif_file: ${{ steps.devsweep.outputs.sarif-file }}
          category: devsweep
```

Pin `Frank1738/devsweep` to the full commit SHA of a release, as devsweep itself would tell you to.

| Input        | Default          | Meaning                                                                      |
| ------------ | ---------------- | ---------------------------------------------------------------------------- |
| `path`       | `.`              | Folder to scan, relative to the workspace                                    |
| `fail-on`    | `low`            | Fail the step at or above this severity: critical, high, medium, low or none |
| `sarif-file` | `devsweep.sarif` | Where to write the SARIF report                                              |

The output `sarif-file` is the path of the report. The upload step uses `!cancelled()` so that findings still reach the Security tab when devsweep fails the step. Private repositories also need `actions: read` for the upload step. Pull requests from forks get a read-only token and can't upload results.

The action runs `action/main.mjs`, a single file bundled from this repository's source with its three dependencies. It is not minified, and CI fails if it differs from a fresh build of the source.

## Releases

Releases come from a signed tag and nothing else:

1. A maintainer pushes a signed, annotated tag (`git tag -s v0.1.0`).
2. The [release workflow](.github/workflows/release.yml) refuses the tag unless GitHub has verified its signature and it matches `package.json`. It then runs the tests, rebuilds the bundle, and stages the version on npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), with provenance. No npm token is stored anywhere.
3. The staged version isn't installable until a maintainer approves it with two-factor authentication. A compromised workflow can stage a release, but it can't publish one.

## Development

Requires Node 22.12 or later.

```sh
npm test                  # vitest
npm run lint              # Biome
npm run typecheck         # tsc
npm run build             # type declarations with tsc, then bundle action/main.mjs and the npm package with rolldown
node dist/devsweep.mjs .  # run the local build
```

After changing anything in `src/`, run `npm run build` and commit `action/main.mjs` too.

`test/fixtures/vulnerable-repo` is a sample repository with one of each problem planted in it.

## License

[MIT](LICENSE)
