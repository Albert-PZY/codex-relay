---
type: module_card
title: cli-architecture
summary: Captures the runtime shape for the codex-relay CLI.
tags:
  - cli
  - architecture
owned_paths:
  - src/**
  - package.json
entrypoints:
  - src/index.ts
status: active
---

# CLI Architecture

## Responsibilities

- Provide a globally installable Node.js CLI named `codex-relay`.
- Manage a pool of relay accounts where each account is an API key plus base URL.
- Launch the official Codex CLI as a child process with per-account environment/config overrides.
- Detect exhausted or unusable accounts, rotate to the next candidate, and resume the interrupted Codex session.

## Entry Points

- `src/index.ts` is the package binary entry point.
- `src/cli.ts` registers account CRUD, import, setup, test, and managed Codex passthrough.
- `--help`, `--version`, and the `version` command describe the wrapper itself, not the upstream Codex CLI.
- `setup` defaults to `data.json`; `import`, `setup`, and first-run auto-import only accept a top-level JSON array of flat account objects.
- Import-style flows use one idempotent merge path that skips duplicate account names and duplicate relay credentials.
- Before a managed run, `src/cli.ts` auto-imports `data.json` only when the account store is empty.
- `src/core/runner.ts` runs each managed attempt inside a temporary Codex home overlay and writes account-specific `auth.json` plus active provider `base_url` there before each child process.
- `src/core/runner.ts` resolves the Codex executable from `CODEX_RELAY_CODEX_PATH` first, then from `PATH`.
- `list` shows active account leases as `in-use` so concurrent terminal allocation is visible.
- `test` is a lightweight `/models` diagnostic; inconclusive checks print `UNKNOWN probe-only`, and rotation decisions are based on actual Codex output.
- `doctor` reports local paths, Codex command resolution, `node-pty` availability, account counts, active leases, pending resumes, stale instance directories, and the last rotation log line.
- `reset --resume` clears pending resumes. `reset --leases` clears local account leases.
- `--no-resume` skips pending-resume loading for the current run and leaves existing pending resume state intact.
- The runner persists interrupted sessions only after it has discovered a concrete session id, and it resumes only that explicit session instead of guessing `--last`.

## Invariants

- Reuse durable history and session files from the configured Codex home. The default is `~/.codex`, and `CODEX_HOME` can point to another Codex home.
- Keep only account-pool state under `~/.codex-relay`.
- Keep account secrets outside the repository and under the user's home data directory.
- Serialize shared account, health, and lease store updates through the local store lock.
- Prefer unleased accounts for concurrent terminals and share only when the pool is tight.
- Scope pending resume lookup and cleanup to the current working directory.
- Treat user exit input such as `Ctrl+C` or `Ctrl+D` as intentional exit, not as a rotation trigger.
- Prefer exact session resume over "latest session" guessing.
- If no concrete session id can be discovered, stop rotation instead of guessing another conversation.

## Extension Points

- Additional relay-specific quota patterns.
- Additional Codex provider config fields if the upstream CLI changes.

## Common Pitfalls

- PTY support can fail on some Windows machines if native dependencies are unavailable; interactive TUI mode requires `node-pty`, while non-interactive `exec` can still use a normal child process.
- Quota detection must be conservative to avoid interrupting valid conversations.
- Relays that do not implement `/models` can still work for real conversations; `UNKNOWN probe-only` from `test` is not an unusable-account verdict.
