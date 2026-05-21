# Acceptance Criteria: Codex Relay

**Spec:** `docs/superpowers/specs/2026-05-18-codex-relay-design.md`
**Date:** 2026-05-18
**Status:** Approved

---

## Criteria

| ID | Description | Test Type | Preconditions | Expected Result |
|----|-------------|-----------|---------------|-----------------|
| AC-001 | The package declares Node.js 22-only support and pnpm package management. | Logic | `package.json` exists. | `engines.node` is `>=22 <23` and `packageManager` starts with `pnpm@`. |
| AC-002 | Account storage validates unique names, URLs, and non-empty API keys. | Logic | Unit tests create temporary config directories. | Invalid records fail; valid accounts round-trip through `accounts.json`. |
| AC-003 | Atomic JSON writes create UTF-8 JSON files and replace existing content safely. | Logic | Unit tests write to a temporary directory. | The final file contains the expected JSON and no temporary files remain. |
| AC-004 | Rotation chooses the preferred or requested account first and skips unavailable accounts. | Logic | Unit tests provide accounts and state with retry timestamps. | Selection order matches requested/preferred order and excludes accounts whose retry time is in the future. |
| AC-005 | Quota detection distinguishes high-confidence, medium-confidence, retry-time, and no-signal output. | Logic | Unit tests feed raw and ANSI-colored output strings. | Detector returns the expected confidence and retry metadata. |
| AC-006 | Runner prepares the Codex home with the selected relay account. | Logic | Unit tests call runner with a temporary Codex home. | Env contains `OPENAI_API_KEY`, args avoid stale base-url overrides, and the Codex home receives matching `auth.json` and `config.toml` updates. |
| AC-007 | Managed runner rotates after high-confidence quota output and resumes the same session when known. | Logic | Unit tests inject a fake process adapter that emits output and exits. | The second spawn uses the next account and includes `resume <sessionId> Continue`. |
| AC-008 | CLI account commands add, list, use, remove, import, and test accounts through the public binary layer. | API | Unit tests invoke the CLI with a temporary config directory. | Commands exit with expected codes and update config files as documented. |
| AC-009 | Git ignores local secrets and design-only local files. | Logic | `.gitignore` exists. | `data.txt`, `data.json`, and `切号工具.md` are ignored by git. |
| AC-010 | GitHub Actions verify and publish the package through release automation. | Logic | Workflow files exist. | CI runs pnpm install, lint, test, build, and pack; Release Please creates release tags and publishes npm with provenance after a release PR is merged. |
| AC-011 | README and contributing docs provide enough setup and commit guidance for new users. | Logic | Docs exist at repository root. | README documents install/config/run/import/security; CONTRIBUTING references Conventional Commits and functional commit grouping. |
| AC-012 | Health state protects failed accounts without active probing cost. | Logic | Unit tests create cooldown and retired records. | Cooling accounts are skipped, successful accounts recover, and accounts that fail continuously for 10 days are retired. |
| AC-013 | Help and version commands describe the wrapper CLI. | API | Unit tests invoke the public CLI. | `--help`, `--version`, and `version` report codex-relay behavior and version. |
| AC-014 | The final project passes local verification. | API | Dependencies are installed. | `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm pack --dry-run` exit with code 0. |
