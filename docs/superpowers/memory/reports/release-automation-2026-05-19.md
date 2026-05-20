## Summary
- Result: updated
- Source spec: none
- Source context: npm publish failed after token update because the scoped package could not be created; branch rules also required exact status contexts.
- Formal commits: `fec354b`, `9821ce9`, `7873b25`, `35eb7c1`, `65609b6`, `499be37`
- Created docs: 1
- Updated docs: 1
- Deferred docs: 0

## Durable updates made
- Runbooks: added `docs/superpowers/memory/release-automation-runbook.md` for package identity, required check names, release PR handling, and post-release verification.
- Index: linked the release automation runbook from `docs/superpowers/memory/index.md`.

## Not promoted
- One-off GitHub run ids, transient TLS timeouts, and local temporary test paths were intentionally excluded.

## Open gaps
- If the repository ruleset changes, update the required-check section and `.github/workflows/ci.yml` together.
