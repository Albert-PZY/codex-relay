# Codex Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. It will decide whether each batch should run in parallel or serial subagent mode and will pass only task-local context to each subagent. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the first release-ready implementation of the codex-relay CLI.

**Architecture:** A TypeScript ESM CLI manages local account/state JSON files and launches the official Codex CLI through an injectable process adapter. Core behavior is split into store, detector, rotator, runner, CLI, and utility modules with unit tests covering each boundary.

**Tech Stack:** Node.js 22, TypeScript, pnpm, commander, zod, node-pty, vitest, tsx.

---

## File Structure

- `package.json`: package metadata, binary, engines, scripts, dependencies.
- `tsconfig.json`: strict TypeScript config for ESM output.
- `vitest.config.ts`: Vitest test config.
- `src/index.ts`: executable entry point.
- `src/cli.ts`: command parsing and command dispatch.
- `src/core/accounts.ts`: account schema, CRUD, import parsing.
- `src/core/state.ts`: runtime state schema and helpers.
- `src/core/detector.ts`: output normalization and quota/retry detection.
- `src/core/rotator.ts`: account selection and availability logic.
- `src/core/runner.ts`: Codex child process orchestration and resume behavior.
- `src/utils/atomic.ts`: atomic JSON writes.
- `src/utils/paths.ts`: config directory path resolution.
- `src/utils/logger.ts`: simple daily log helper.
- `src/utils/terminal.ts`: terminal recovery.
- `src/types.ts`: shared public types.
- `tests/**/*.test.ts`: unit and CLI tests.
- `.github/workflows/ci.yml`: install/lint/test/build/pack checks.
- `.github/workflows/release-please.yml`: release PR, GitHub Release, tag sync, and npm publish.
- `.github/release-please-config.json` and `.release-please-manifest.json`: release automation.
- `README.md`: user docs.
- `CONTRIBUTING.md`: commit and contribution rules.

## Tasks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/types.ts`

- [ ] Write the minimal package and TypeScript scaffold for Node.js 22 ESM.
- [ ] Add scripts for `build`, `test`, `lint`, `typecheck`, and `dev`.
- [ ] Add an executable `src/index.ts` that calls `main()` from `src/cli.ts`.
- [ ] Run `pnpm install`.
- [ ] Commit with `chore: scaffold node cli project`.

### Task 2: Storage Utilities

**Files:**
- Create: `src/utils/atomic.ts`
- Create: `src/utils/paths.ts`
- Create: `tests/atomic.test.ts`

- [ ] Write failing tests for atomic JSON writes and path overrides.
- [ ] Implement atomic write/read helpers and config path resolution.
- [ ] Run focused tests, then full tests.
- [ ] Commit with `feat: add local storage utilities`.

### Task 3: Account And State Core

**Files:**
- Create: `src/core/accounts.ts`
- Create: `src/core/state.ts`
- Create: `tests/accounts.test.ts`
- Create: `tests/state.test.ts`

- [ ] Write failing tests for account CRUD, validation, import parsing, preferred updates, and state persistence.
- [ ] Implement zod schemas and store helpers.
- [ ] Run focused tests, then full tests.
- [ ] Commit with `feat: manage relay accounts and state`.

### Task 4: Detection And Rotation

**Files:**
- Create: `src/core/detector.ts`
- Create: `src/core/rotator.ts`
- Create: `tests/detector.test.ts`
- Create: `tests/rotator.test.ts`

- [ ] Write failing tests for high/medium/no-signal detection, retry extraction, custom patterns, and ANSI stripping.
- [ ] Write failing tests for requested/preferred/current selection and retry skipping.
- [ ] Implement detector and rotator.
- [ ] Run focused tests, then full tests.
- [ ] Commit with `feat: detect quota signals and rotate accounts`.

### Task 5: Runner

**Files:**
- Create: `src/core/runner.ts`
- Create: `src/utils/terminal.ts`
- Create: `src/utils/logger.ts`
- Create: `tests/runner.test.ts`

- [ ] Write failing tests for env/argument builders and managed rotation with fake process adapter.
- [ ] Implement Codex spawn orchestration, session id extraction, conservative rotation, and terminal cleanup.
- [ ] Run focused tests, then full tests.
- [ ] Commit with `feat: run codex with automatic account rotation`.

### Task 6: CLI Commands

**Files:**
- Create: `src/cli.ts`
- Create: `tests/cli.test.ts`

- [ ] Write failing tests for `add`, `list`, `use`, `remove`, `import`, `test`, and passthrough runner dispatch.
- [ ] Implement commander command surface with interactive prompts only for missing required account fields.
- [ ] Run focused tests, then full tests.
- [ ] Commit with `feat: expose codex-relay cli commands`.

### Task 7: Documentation And Release Automation

**Files:**
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-please.yml`
- Create: `.github/release-please-config.json`
- Create: `.release-please-manifest.json`
- Modify: `docs/superpowers/memory/*.md`

- [ ] Write README and contributing docs.
- [ ] Add GitHub Actions CI and npm publish workflows.
- [ ] Update memory docs from draft to active where implementation confirms them.
- [ ] Run docs-related checks.
- [ ] Commit with `docs: add usage and release guidance`.

### Task 8: Final Verification

**Files:**
- Modify as needed based on verification output.

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm pack --dry-run`.
- [ ] Check `git status --short`.
- [ ] Commit any final fixes with a Conventional Commit message.
