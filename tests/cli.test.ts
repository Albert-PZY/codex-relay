import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliProgram, main } from '../src/cli.js';
import { loadAccountsFile } from '../src/core/accounts.js';

const promptInput = vi.hoisted(() => vi.fn());

vi.mock('@inquirer/prompts', () => ({
  input: promptInput
}));

const tmpDir = fileURLToPath(new URL('./tmp-cli/', import.meta.url));
const accountsPath = join(tmpDir, 'accounts.json');
const statePath = join(tmpDir, 'state.json');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  promptInput.mockReset();
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

  it('prompts for missing add fields and stores the optional model', async () => {
    promptInput
      .mockResolvedValueOnce('sk-prompt')
      .mockResolvedValueOnce('https://prompt.example.com/v1');
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-prompt', '--model', 'gpt-5.2']);

    const file = await loadAccountsFile(accountsPath);
    expect(promptInput).toHaveBeenNthCalledWith(1, { message: 'API key' });
    expect(promptInput).toHaveBeenNthCalledWith(2, { message: 'Base URL' });
    expect(file.accounts[0]).toMatchObject({
      name: 'relay-prompt',
      apiKey: 'sk-prompt',
      baseUrl: 'https://prompt.example.com/v1',
      model: 'gpt-5.2'
    });
  });

  it('imports accounts from a json file', async () => {
    const importPath = join(tmpDir, 'import.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1'
        }
      ]),
      'utf8'
    );
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]?.name).toBe('relay-a');
  });

  it('rejects import files that are not top-level arrays', async () => {
    const importPath = join(tmpDir, 'wrapped.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify({
        accounts: [
          {
            name: 'relay-a',
            apiKey: 'sk-a',
            baseUrl: 'https://a.example.com/v1'
          }
        ]
      }),
      'utf8'
    );
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'import', importPath])).rejects.toThrow(
      /top-level array/i
    );
  });

  it('skips duplicate accounts during import', async () => {
    const importPath = join(tmpDir, 'duplicate.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1'
        },
        {
          name: 'relay-a',
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-a']);
    expect(file.accounts[0]?.apiKey).toBe('sk-a');
    expect(output.join('\n')).toContain('Imported 1 account');
    expect(output.join('\n')).toContain('Skipped 1 duplicate account');
  });

  it('sets up a json file with one base url', async () => {
    const importPath = join(tmpDir, 'data.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        },
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-two',
          name: 'relay-two'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync([
      'node',
      'codex-relay',
      'setup',
      importPath
    ]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-example-com-1', 'relay-two']);
    expect(output.join('\n')).toContain('Imported 2 accounts');
    expect(output.join('\n')).toContain('Run: codex-relay');
  });

  it('skips duplicate accounts during setup', async () => {
    const importPath = join(tmpDir, 'setup-duplicate.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        },
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        },
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-two'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync([
      'node',
      'codex-relay',
      'setup',
      importPath
    ]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual([
      'relay-example-com-1',
      'relay-example-com-2'
    ]);
    expect(output.join('\n')).toContain('Imported 2 accounts');
    expect(output.join('\n')).toContain('Skipped 1 duplicate account');
  });

  it('skips duplicate imported credentials that differ only by name', async () => {
    const importPath = join(tmpDir, 'duplicate-credentials.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-same'
        },
        {
          name: 'relay-b',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-same'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts).toHaveLength(1);
    expect(output.join('\n')).toContain('Skipped 1 duplicate account');
  });

  it('sets up the default data.json when no file argument is provided', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'data.json'),
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        }
      ]),
      'utf8'
    );
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

  it('prints failed test status when the relay check throws', async () => {
    const output: string[] = [];
    const fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

    expect(output.join('\n')).toContain('relay-a FAILED');
  });

  it('throws when testing a missing account', async () => {
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'test', 'missing'])).rejects.toThrow(
      /does not exist/i
    );
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

  it('parses inline account passthrough options', async () => {
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-b'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    await program.parseAsync(['node', 'codex-relay', '--account=relay-b', 'hello']);

    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        accountName: 'relay-b',
        codexArgs: ['hello']
      }),
      expect.anything()
    );
  });

  it('sets process exitCode when the managed runner exits unsuccessfully', async () => {
    const previousExitCode = process.exitCode;
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 7,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    try {
      await program.parseAsync(['node', 'codex-relay', 'hello']);

      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('skips auto-import when accounts already exist', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'data.json'),
      JSON.stringify([
        {
          baseUrl: 'https://new.example.com/v1',
          apiKey: 'sk-new'
        }
      ]),
      'utf8'
    );
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
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    const cwd = process.cwd();

    try {
      process.chdir(tmpDir);
      await program.parseAsync(['node', 'codex-relay', 'hello']);
    } finally {
      process.chdir(cwd);
    }

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-a']);
  });

  it('auto-imports data.json before the first managed run', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'data.json'),
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        }
      ]),
      'utf8'
    );
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

  it('rethrows non-help errors from main', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main(['import', join(tmpDir, 'missing.json')])).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('reports command errors through the configured error stream', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      error: (text) => errors.push(text)
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'remove', 'missing'])).rejects.toThrow(
      /does not exist/i
    );
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
  });
});
