# codex-relay

Lightweight relay account pool management for the official Codex CLI.

`codex-relay` lets you keep multiple relay `apiKey + baseUrl` pairs locally, run Codex through the selected relay, and automatically rotate to another account when the current relay is exhausted or temporarily unusable.

## Requirements

- Node.js `>=22 <23`
- pnpm for development
- The official `codex` CLI installed and available on `PATH`

## Install

After the package is published:

```bash
npm install -g codex-relay
```

For local development:

```bash
pnpm install
pnpm build
pnpm dev -- --help
```

## Quick Start

Add relay accounts:

```bash
codex-relay add relay-a --key sk-xxx --base-url https://relay-a.example.com/v1
codex-relay add relay-b --key sk-yyy --base-url https://relay-b.example.com/v1
```

Run Codex through the managed account pool:

```bash
codex-relay "help me refactor this project"
```

Start from a specific account:

```bash
codex-relay --account relay-b "continue the previous task"
```

## Commands

```bash
codex-relay add <name> --key <key> --base-url <url> [--model <model>] [--overwrite]
codex-relay list
codex-relay use <name>
codex-relay remove <name>
codex-relay import <file> [--overwrite]
codex-relay test [name]
codex-relay [...codexArgs]
```

`codex-relay` forwards unknown root arguments to the official `codex` CLI.

## Import Format

Text import:

```txt
https://relay-a.example.com/v1,sk-xxx,relay-a
https://relay-b.example.com/v1,sk-yyy,relay-b
```

JSON import:

```json
{
  "accounts": [
    {
      "name": "relay-a",
      "apiKey": "sk-xxx",
      "baseUrl": "https://relay-a.example.com/v1"
    }
  ]
}
```

## How Rotation Works

For every managed run, `codex-relay`:

1. Reads accounts from `~/.codex-relay/accounts.json`.
2. Starts `codex` with `OPENAI_API_KEY` set to the selected account key.
3. Passes `-c openai_base_url="<baseUrl>"` to Codex for that run only.
4. Watches Codex output for high-confidence quota, balance, auth, and relay failure signals.
5. Stops the failed process, rotates to the next available account, and starts `codex resume <session-id> Continue`.
6. Falls back to `codex resume --last Continue` only when no session id is detected.

The user's `~/.codex` config and auth files are not modified.

## Local Data

Runtime data is stored outside the repository:

```txt
~/.codex-relay/
  accounts.json
  state.json
  logs/
```

Secrets such as `data.txt`, `data.json`, `.env*`, and local runtime files are ignored by git.

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
pnpm pack --dry-run
```

This project intentionally uses a small dependency set: TypeScript, commander, zod, strip-ansi, optional node-pty, and vitest.

## Release

Release automation is based on Conventional Commits and release-please. Merging a release PR creates a GitHub Release. The publish workflow then runs `pnpm publish --provenance --access public`.
