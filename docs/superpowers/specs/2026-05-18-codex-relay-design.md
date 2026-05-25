# Codex Relay Design

**Status:** Approved
**Date:** 2026-05-18

## Goal

Build a lightweight Node.js CLI that manages multiple relay API keys/base URLs for the official Codex CLI, automatically rotates accounts when the current relay cannot continue, and resumes the interrupted conversation with minimal user setup.

## Architecture

The package exposes a global `codex-relay` binary. Management commands read and write `~/.codex-relay/accounts.json`, `~/.codex-relay/state.json`, and `~/.codex-relay/health.json`. Managed Codex runs launch the official `codex` executable as a child process. Each managed run creates a temporary Codex home overlay under `~/.codex-relay/instances/<run-id>`, links durable Codex history/session data from the configured Codex home, and writes per-account `auth.json.OPENAI_API_KEY` plus the active model provider `base_url` before each attempt. The configured Codex home is `CODEX_HOME` when set, otherwise the user's `~/.codex`.

The runner keeps output passthrough simple. It watches child output with a conservative detector. High-confidence quota or unusable-environment messages trigger immediate rotation. Medium-confidence messages rotate only when the child exits unsuccessfully. After rotation, the runner restarts Codex with `resume <session-id> Continue` only when it can identify a concrete session id from buffered output or Codex session files; otherwise it stops instead of guessing another conversation.

## CLI Surface

- `codex-relay [...codexArgs]` starts a managed Codex session.
- `codex-relay --help`, `codex-relay --version`, and `codex-relay version` expose wrapper help and version.
- `codex-relay --account <name> [...codexArgs]` starts from a named relay account.
- `codex-relay add <name> --key <key> --base-url <url> [--model <model>] [--overwrite]` adds an account non-interactively and can replace a same-name account when requested.
- `codex-relay add <name>` prompts for missing values.
- `codex-relay list` prints account names, relay URLs, default marker, health status, and active lease marker.
- `codex-relay remove <name>` removes an account and updates preferred/default state.
- `codex-relay use <name>` marks an account as the preferred starting account.
- `codex-relay import <file>` imports relay accounts from a JSON top-level array of flat account objects.
- `codex-relay setup [file]` imports `data.json` by default and uses the same JSON-only import path.
- `codex-relay test [name]` checks one or all accounts through a lightweight OpenAI-compatible `/models` request. `UNKNOWN` is a diagnostic result, not a rotation block.

## Data Contract

`accounts.json` is versioned and contains account records with unique names, API keys, base URLs, optional model names, and timestamps. `state.json` stores the current index, last successful account, active leases, and updated timestamp. `health.json` stores cooldown and retirement state. Accounts that remain in cooldown for 10 continuous days are removed from the active pool and recorded under `retired`. Writes use temporary files plus rename. Import files are JSON arrays where each item has `baseUrl`, `apiKey`, optional `name`, and optional `model`.

Local files containing secrets are ignored by git: `data.txt`, `data.json`, `切号工具.md`, `.env*`, logs, and local runtime data.

## Error Handling

Detector output is normalized with Node's built-in VT control stripping. Custom quota strings from config are supported. Rotation skips accounts marked unavailable in health state until their cooldown has passed. Rotation decisions use actual Codex output, not the `/models` preflight. If no account remains, the CLI restores terminal state, prints a clear message, and exits non-zero.

Account management commands validate duplicate names, valid URLs, and non-empty keys. Test commands report individual account status without exposing full API keys.

## Packaging And Release

The repository uses Node.js `>=22 <23`, TypeScript, ESM, pnpm, commander, zod, node-pty, and vitest. GitHub Actions run install, lint, test, build, and pack checks on pull requests and main. Releases use Release Please with Conventional Commits, npm provenance publishing, and moving tag sync for `vX` and `vX.Y`.

If a PR is mergeable but branch protection blocks normal merge after required checks have passed, maintainers may use an admin merge or force-capable merge path that is allowed by the repository rules. The release flow must not stop at a protected-branch merge error: finish the merge, let Release Please create the version PR, trigger checks on the Release Please branch when needed, merge the version PR, then verify GitHub Release, tags, npm, and the local global install.

## Documentation

`README.md` explains install, quick start, account import, managed run, rotation limits, and security notes. `CONTRIBUTING.md` defines Conventional Commits, branch discipline, pnpm-only workflow, and functional commit grouping. `.gitignore` excludes sensitive local files and generated build output.
