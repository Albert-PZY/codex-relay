# Contributing to codex-relay

## Workflow

- Use `npm` for dependency installation and the default verification path.
- pnpm remains supported for local development when you prefer it.
- Keep changes small and commit them by feature area.
- Run `npm run lint`, `npm test`, and `npm run build` before opening a PR.

## Commit Format

This repository follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

### Format

```text
<type>[optional scope]: <short summary>
```

### Recommended types

- `feat`: new user-facing behavior
- `fix`: bug fixes
- `docs`: documentation only
- `test`: test-only changes
- `refactor`: internal code changes without behavior change
- `chore`: tooling, dependency, or repository maintenance
- `ci`: CI workflow changes

### Examples

```text
feat: add relay account import command
fix: skip unavailable relay accounts during rotation
docs: add setup and release instructions
ci: publish npm package from GitHub release
```

## Pull Request Expectations

- Describe the behavior change clearly.
- List the commands you ran to verify the change.
- Keep sensitive data out of commits.
- Do not commit local runtime files, generated artifacts, or relay credentials.

## Release Discipline

- Group unrelated changes into separate commits.
- Prefer one commit per feature or repair.
- Avoid mixing docs, tooling, and runtime code unless the change is genuinely coupled.
