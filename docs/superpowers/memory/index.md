---
type: module_card
title: repository-memory-index
summary: Entry point for durable knowledge about the codex-relay CLI.
tags:
  - memory
  - index
owned_paths:
  - docs/superpowers/memory/**
status: active
---

# Repository Memory

## Covered Domains

- CLI architecture and runtime boundaries: `docs/superpowers/memory/cli-architecture.md`
- Account and state file contract: `docs/superpowers/memory/account-state-contract.md`
- Release automation and npm publish runbook: `docs/superpowers/memory/release-automation-runbook.md`

## Runtime Anchors

- Account-pool data lives under `~/.codex-relay` unless `CODEX_RELAY_HOME` is set.
- Managed runs reuse the official Codex home: `CODEX_HOME` first, otherwise `~/.codex`.
- JSON import accepts only a top-level array of flat account objects.
- Rotation health, cooldown, leases, and 10-day retirement are persistent local state.
- Release automation is driven by Conventional Commits and Release Please.
