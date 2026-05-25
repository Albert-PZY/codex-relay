---
type: contract
title: account-state-contract
summary: Defines the stable local data contract for account pool and runtime state files.
tags:
  - config
  - state
owned_paths:
  - src/core/accounts.ts
  - src/core/health.ts
  - src/core/state.ts
  - src/core/rotator.ts
  - src/core/store-lock.ts
status: active
---

# Account And State Contract

## Scope

The CLI stores account pool data and runtime rotation state under the user's home directory, not in the project workspace.

## Producers And Consumers

- Account management commands produce and update account records.
- The managed runner consumes account records and updates runtime state after account selection or detection events.

## Schema Rules

- `accounts.json` contains `version`, `preferred`, `customQuotaPatterns`, and `accounts`.
- Each account contains `name`, `apiKey`, `baseUrl`, optional `model`, and `addedAt`.
- Import files use a top-level JSON array; each item contains `baseUrl`, `apiKey`, optional `name`, and optional `model`.
- `state.json` contains `version`, `currentIndex`, optional `lastSuccessfulAccount`, optional `pendingResumes`, `leases`, and `updatedAt`.
- `pendingResumes` maps normalized working-directory keys to interrupted Codex sessions with `sessionId`, `prompt`, optional `cwd`, and `updatedAt`.
- `leases` records active local runner sessions with `ownerId`, `accountName`, `pid`, optional `cwd`, `startedAt`, `updatedAt`, and `expiresAt`.
- `health.json` contains `version`, `accounts`, `retired`, and `updatedAt`.
- Active health records contain `status`, `consecutiveFailures`, optional `baseUrl`, `reason`, failure timestamps, success timestamp, and `cooldownUntil`.
- Retired health records contain `name`, optional `baseUrl`, `reason`, `firstFailedAt`, `lastFailedAt`, and `removedAt`.
- Managed runs read durable history and session files from the configured Codex home while writing account-specific auth and config into a temporary run-scoped Codex home.

## Invariants

- Account names are unique.
- Import-style writes are idempotent: duplicate names and duplicate `baseUrl + apiKey + model` credentials are skipped instead of requiring manual cleanup.
- Shared store writes are serialized through `store.lock`, then written atomically through a temporary file plus rename.
- Concurrent runner sessions should prefer unleased accounts. Sharing an account is a fallback only when all available accounts are already leased.
- Leases are short-lived and expire automatically if a terminal exits unexpectedly.
- Pending resumes are scoped by working directory. A launch in one project must not consume or delete another project's pending resume.
- A runner must update the run-scoped Codex home before every attempt so `auth.json` and provider `base_url` match the selected account.
- A cooldown account becomes selectable again after `cooldownUntil`.
- An account that remains in cooldown continuously for 10 days is removed from `accounts.json` and recorded under `health.json.retired`.
- `data.txt`, `data.json`, `切号工具.md`, and local runtime data are ignored by git.

## Schema Policy

- Local JSON files use the current schema only. Unknown fields and malformed records fail fast.
