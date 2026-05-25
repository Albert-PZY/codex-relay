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
| AC-006 | Runner prepares a run-scoped Codex home overlay with the selected relay account. | Logic | Unit tests call runner with a temporary Codex home. | Env contains `OPENAI_API_KEY`, args avoid stale base-url overrides, durable history/session files are linked, and the run-scoped Codex home receives matching `auth.json` and `config.toml` updates. |
| AC-007 | Managed runner rotates after high-confidence quota output and resumes the same session when known. | Logic | Unit tests inject a fake process adapter that emits output and exits. | The second spawn uses the next account and includes `resume <sessionId> Continue`. |
| AC-008 | CLI account commands add, list, use, remove, import, and test accounts through the public binary layer. | API | Unit tests invoke the CLI with a temporary config directory. | Commands exit with expected codes and update config files as documented. |
| AC-009 | Git ignores local secrets and design-only local files. | Logic | `.gitignore` exists. | `data.txt`, `data.json`, and `切号工具.md` are ignored by git. |
| AC-010 | GitHub Actions verify and publish the package through release automation. | Logic | Workflow files exist. | CI runs pnpm install, lint, test, build, and pack; Release Please creates release tags and publishes npm with provenance after a release PR is merged. |
| AC-011 | README and contributing docs provide enough setup and commit guidance for new users. | Logic | Docs exist at repository root. | README documents install/config/run/import/security; CONTRIBUTING references Conventional Commits and functional commit grouping. |
| AC-012 | Health state protects failed accounts without active probing cost. | Logic | Unit tests create cooldown and retired records. | Cooling accounts are skipped, successful accounts recover, and accounts that fail continuously for 10 days are retired. |
| AC-013 | Help and version commands describe the wrapper CLI. | API | Unit tests invoke the public CLI. | `--help`, `--version`, and `version` report codex-relay behavior and version. |
| AC-014 | Pending resume state is isolated by working directory. | Logic | Unit tests create interrupted sessions for multiple workspaces. | A managed run resumes only the matching workspace session and preserves other workspace entries. |
| AC-015 | Users can intentionally bypass or clear recovery state. | API | Unit tests invoke the CLI and runner. | `--no-resume` does not consume pending resumes; `reset --resume` clears them; `reset --leases` clears active leases. |
| AC-016 | Local diagnostics expose actionable runtime state. | API | Unit tests invoke `doctor` with temporary config paths. | Output includes package version, Node version, `node-pty`, Codex command, local paths, account counts, pending resumes, leases, stale instances, and last rotation. |
| AC-017 | User exit input does not cause accidental rotation. | Logic | Unit tests simulate user `Ctrl+C` while failure text is visible. | The runner exits without switching accounts or auto-resuming. |
| AC-018 | `/models` preflight is clearly diagnostic. | API | Unit tests mock `/models` responses. | Unsupported or inconclusive relay responses print `UNKNOWN probe-only` and do not mark the account unusable. |
| AC-019 | The final project passes local verification. | API | Dependencies are installed. | `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm pack --dry-run` exit with code 0. |
