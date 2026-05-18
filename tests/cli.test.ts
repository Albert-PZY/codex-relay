import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliProgram, main } from '../src/cli.js';
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

  it('sets up key-only files with one base url', async () => {
    const importPath = join(tmpDir, 'keys.txt');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(importPath, 'sk-one\nsk-two\n', 'utf8');
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync([
      'node',
      'codex-relay',
      'setup',
      importPath,
      '--base-url',
      'https://relay.example.com/v1',
      '--name',
      'relay'
    ]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-1', 'relay-2']);
    expect(output.join('\n')).toContain('Imported 2 accounts');
    expect(output.join('\n')).toContain('Run: codex-relay');
  });

  it('sets up the default data.txt when no file argument is provided', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, 'data.txt'), 'base_url = "https://relay.example.com/v1"\nsk-one\n', 'utf8');
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });
    const cwd = process.cwd();

    try {
      process.chdir(tmpDir);
      await program.parseAsync(['node', 'codex-relay', 'setup']);
    } finally {
      process.chdir(cwd);
    }

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]).toMatchObject({
      name: 'relay-example-com-1',
      apiKey: 'sk-one',
      baseUrl: 'https://relay.example.com/v1'
    });
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

  it('auto-imports data.txt before the first managed run', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, 'data.txt'), 'base_url = "https://relay.example.com/v1"\nsk-one\n', 'utf8');
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-example-com-1'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });
    const cwd = process.cwd();

    try {
      process.chdir(tmpDir);
      await program.parseAsync(['node', 'codex-relay', 'hello']);
    } finally {
      process.chdir(cwd);
    }

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]?.name).toBe('relay-example-com-1');
    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({ codexArgs: ['hello'] }),
      expect.objectContaining({ paths: { accounts: accountsPath, state: statePath } })
    );
  });

  it('prints help without throwing an error from main', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main(['--help'])).resolves.toBeUndefined();

    expect(output.mock.calls.flat().join('\n')).toContain('Usage: codex-relay');
    expect(error).not.toHaveBeenCalled();
  });
});
