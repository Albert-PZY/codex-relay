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
- `setup` defaults to `data.txt` and accepts segmented `base_url` blocks, standalone URL blocks, JSON pools, and key-only files when `--base-url` is provided.
- `import`, `setup`, and first-run auto-import use one idempotent merge path that skips duplicate account names and duplicate relay credentials.
- Before a managed run, `src/cli.ts` auto-imports `data.txt` only when the account store is empty.
- `src/core/runner.ts` injects `OPENAI_API_KEY` and passes `-c openai_base_url="..."` per Codex child process.

## Invariants

- Do not modify the user's `~/.codex` configuration or auth files.
- Keep account secrets outside the repository and under the user's home data directory.
- Prefer exact session resume over "latest session" guessing.
- Fall back to `resume --last Continue` only when the current output does not expose a session id.

## Extension Points

- Additional relay-specific quota patterns.
- Additional Codex provider config flags if the upstream CLI changes.

## Common Pitfalls

- PTY support can fail on some Windows machines if native dependencies are unavailable; runtime falls back to a normal child process.
- Quota detection must be conservative to avoid interrupting valid conversations.
