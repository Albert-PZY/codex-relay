---
type: runbook
title: release-automation-runbook
summary: Stable release and npm publish rules for codex-relay.
tags:
  - release
  - npm
  - ci
owned_paths:
  - .github/workflows/ci.yml
  - .github/workflows/release-please.yml
  - .github/release-please-config.json
  - package.json
status: active
---

# Release Automation Runbook

## Package Identity

- The npm package name is `codex-relay-cli`.
- The globally installed binary remains `codex-relay`.
- Do not publish under `@albert-pzy/codex-relay` unless the npm scope exists and the token has publish rights for that scope.

## Required Checks

- The repository ruleset for `main` requires two status contexts: `CI` and `verify`.
- `.github/workflows/ci.yml` therefore emits the full validation job as `CI` and a lightweight dependent status job as `verify`.
- Keep both status names unless the GitHub ruleset is changed at the same time.

## Release Flow

1. Merge normal development through a pull request into `main`.
2. `Release Please` evaluates Conventional Commits and opens a release PR when a version bump is needed.
3. Merge the release PR after `CI` and `verify` pass.
4. The main-branch `Release Please` run creates the GitHub Release, publishes to npm, and syncs moving tags `vX` and `vX.Y`.

## Release PR Checks

- Release Please uses a temporary branch named like `release-please--branches--main--components--codex-relay-cli` for the release PR.
- That branch belongs to the automation flow and can be deleted after the release PR is merged or closed.
- Release Please PRs created by GitHub Actions may not automatically trigger PR checks.
- If a release PR has no checks, push an empty commit to that release branch:

```bash
git checkout -B <release-please-branch> origin/<release-please-branch>
git commit --allow-empty -m "chore: trigger release checks"
git push origin <release-please-branch>
```

## Protected Branch Merge

- Do not stop the release flow just because `gh pr merge` reports a protected-branch merge error.
- If the PR is mergeable and the required `CI` and `verify` checks have passed, use the repository-allowed admin merge path:

```bash
gh pr merge <pr-number> --admin --squash --delete-branch \
  --subject "<conventional commit subject>" \
  --body "<short merge body>"
```

- After merging a feature PR, watch the main-branch `Release Please` run.
- If it opens a release PR without checks, trigger checks on the release branch with the empty-commit flow above.
- Merge the release PR with the same admin merge path once checks pass.

## Verification Commands

After a release, verify:

```bash
npm view codex-relay-cli name version dist-tags bin --registry=https://registry.npmjs.org
gh release list --limit 5
git ls-remote --tags origin
npm install -g codex-relay-cli@latest --registry=https://registry.npmjs.org
codex-relay --help
```

## Windows pnpm Compatibility Shim SOP

On this machine, `pnpm add -g codex-relay-cli@<version> --global-dir "G:\develop\nvm\nodejs" --config.global-bin-dir="G:\develop\nvm\nodejs"` can download the package but fail while refreshing the root `codex-relay` shims with `ENOENT`. When that happens:

1. Confirm the published version:

```powershell
npm view codex-relay-cli version --registry=https://registry.npmjs.org
```

2. Locate the downloaded package in pnpm store:

```powershell
Get-ChildItem -Force "G:\develop\pnpm\store\v11\links\@\codex-relay-cli\<version>" -Directory
```

3. Verify `<hash>\node_modules\codex-relay-cli\dist\index.js` exists.

4. Rewrite `G:\develop\nvm\nodejs\codex-relay`, `codex-relay.CMD`, and `codex-relay.ps1` to call that absolute `dist\index.js` and prepend these `NODE_PATH` entries:

```text
<hash>\node_modules\codex-relay-cli\node_modules
<hash>\node_modules
G:\develop\nvm\nodejs\v11\<latest-global-dir>\node_modules\.pnpm\node_modules
```

5. Verify:

```powershell
codex-relay --version
codex-relay --help
codex-relay list
```

Do not kill unrelated `node.exe`, Codex, MCP, or dev-server processes while repairing the shim. Only touch the `codex-relay*` shim files and the matching codex-relay-cli global package path.

## Known Failure Modes

- `Scope not found` during npm publish means the configured package scope does not exist or the token cannot publish to it.
- `GitHub Actions is not permitted to create or approve pull requests` means repository Actions settings do not allow workflow-created PRs.
- A required status check can be "expected" even when tests passed if the job display name does not match the ruleset context.
