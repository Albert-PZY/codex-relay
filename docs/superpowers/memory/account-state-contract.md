---
type: contract
title: account-state-contract
summary: Defines the stable local data contract for account pool and runtime state files.
tags:
  - config
  - state
owned_paths:
  - src/core/accounts.ts
  - src/core/state.ts
  - src/core/rotator.ts
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
- `state.json` contains `version`, `currentIndex`, optional `lastSuccessfulAccount`, `retryAvailability`, and `updatedAt`.

## Invariants

- Account names are unique.
- Import-style writes are idempotent: duplicate names and duplicate `baseUrl + apiKey + model` credentials are skipped instead of requiring manual cleanup.
- Writes are atomic through a temporary file plus rename.
- `data.txt`, `data.json`, and local runtime data are ignored by git.

## Compatibility Notes

- Versioned schemas must remain explicit so future migrations can be written deliberately.
