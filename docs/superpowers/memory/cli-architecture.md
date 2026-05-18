---
type: module_card
title: cli-architecture
summary: Captures the intended runtime shape for codex-relay before implementation.
tags:
  - cli
  - architecture
owned_paths:
  - src/**
  - package.json
entrypoints:
  - src/index.ts
status: draft
---

# CLI Architecture

## Responsibilities

- Provide a globally installable Node.js CLI named `codex-relay`.
- Manage a pool of relay accounts where each account is an API key plus base URL.
- Launch the official Codex CLI as a child process with per-account environment/config overrides.
- Detect exhausted or unusable accounts, rotate to the next candidate, and resume the interrupted Codex session.

## Entry Points

- `src/index.ts` will be the package binary entry point.
- User-facing commands will include account CRUD, import, test, and managed Codex passthrough.

## Invariants

- Do not modify the user's `~/.codex` configuration or auth files.
- Keep account secrets outside the repository and under the user's home data directory.
- Prefer exact session resume over "latest session" guessing.

## Extension Points

- Additional relay-specific quota patterns.
- Additional Codex provider config flags if the upstream CLI changes.

## Common Pitfalls

- PTY support can fail on some Windows machines if native dependencies are unavailable.
- Quota detection must be conservative to avoid interrupting valid conversations.
