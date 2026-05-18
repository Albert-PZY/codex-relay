import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliProgram } from '../src/cli.js';
import { loadAccountsFile } from '../src/core/accounts.js';

const tmpDir = fileURLToPath(new URL('./tmp-cli/', import.meta.url));
const accountsPath = join(tmpDir, 'accounts.json');
const statePath = join(tmpDir, 'state.json');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cli', () => {
  it('adds, lists, uses, and removes accounts', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-b', '--key', 'sk-b', '--base-url', 'https://b.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'use', 'relay-b']);
    await program.parseAsync(['node', 'codex-relay', 'list']);
    await program.parseAsync(['node', 'codex-relay', 'remove', 'relay-a']);

    const file = await loadAccountsFile(accountsPath);
    expect(file.preferred).toBe('relay-b');
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-b']);
    expect(output.join('\n')).toContain('* relay-b');
  });

  it('imports accounts from a text file', async () => {
    const importPath = join(tmpDir, 'import.txt');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(importPath, 'https://a.example.com/v1,sk-a,relay-a\n', 'utf8');
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]?.name).toBe('relay-a');
  });

  it('tests accounts with an injected fetch implementation', async () => {
    const output: string[] = [];
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      fetch
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

    expect(fetch).toHaveBeenCalledWith('https://a.example.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-a' })
    }));
    expect(output.join('\n')).toContain('relay-a OK');
  });

  it('dispatches unknown commands to the managed runner', async () => {
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    await program.parseAsync(['node', 'codex-relay', '--account', 'relay-a', 'hello']);

    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        accountName: 'relay-a',
        codexArgs: ['hello']
      }),
      expect.objectContaining({ paths: { accounts: accountsPath, state: statePath } })
    );
  });
});
