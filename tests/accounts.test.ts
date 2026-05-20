import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAccount,
  addAccounts,
  importAccountsFromFile,
  mergeImportedAccounts,
  listAccounts,
  loadAccountsFile,
  removeAccount,
  saveAccountsFile,
  setPreferredAccount
} from '../src/core/accounts.js';

const tmpDir = fileURLToPath(new URL('./tmp-accounts/', import.meta.url));
const accountsPath = join(tmpDir, 'accounts.json');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('account store', () => {
  it('adds and lists accounts', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://relay.example.com/v1'
    });

    const accounts = await listAccounts(accountsPath);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://relay.example.com/v1'
    });
  });

  it('rejects duplicate names unless overwrite is enabled', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://relay-a.example.com/v1'
    });

    await expect(
      addAccount(accountsPath, {
        name: 'relay-a',
        apiKey: 'sk-b',
        baseUrl: 'https://relay-b.example.com/v1'
      })
    ).rejects.toThrow(/already exists/i);

    await addAccount(
      accountsPath,
      {
        name: 'relay-a',
        apiKey: 'sk-b',
        baseUrl: 'https://relay-b.example.com/v1'
      },
      { overwrite: true }
    );

    const [account] = await listAccounts(accountsPath);
    expect(account?.apiKey).toBe('sk-b');
  });

  it('adds multiple accounts atomically', async () => {
    await expect(
      addAccounts(accountsPath, [
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://relay-a.example.com/v1'
        },
        {
          name: 'relay-a',
          apiKey: 'sk-b',
          baseUrl: 'https://relay-b.example.com/v1'
        }
      ])
    ).rejects.toThrow(/already exists/i);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts).toHaveLength(0);
  });

  it('merges imported accounts while skipping duplicate names', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-existing',
      baseUrl: 'https://existing.example.com/v1'
    });

    const imported = await mergeImportedAccounts(accountsPath, [
      {
        name: 'relay-a',
        apiKey: 'sk-a2',
        baseUrl: 'https://a2.example.com/v1'
      },
      {
        name: 'relay-b',
        apiKey: 'sk-b1',
        baseUrl: 'https://b.example.com/v1'
      },
      {
        name: 'relay-b',
        apiKey: 'sk-b2',
        baseUrl: 'https://b2.example.com/v1'
      }
    ]);

    expect(imported.map((account) => account.name)).toEqual(['relay-b']);
    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-a', 'relay-b']);
    expect(file.accounts[0]?.apiKey).toBe('sk-existing');
    expect(file.accounts[1]?.apiKey).toBe('sk-b1');
  });

  it('merges imported accounts while skipping duplicate relay keys', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-same',
      baseUrl: 'https://same.example.com/v1'
    });

    const imported = await mergeImportedAccounts(accountsPath, [
      {
        name: 'relay-b',
        apiKey: 'sk-same',
        baseUrl: 'https://same.example.com/v1'
      },
      {
        name: 'relay-c',
        apiKey: 'sk-same',
        baseUrl: 'https://same.example.com/v1'
      },
      {
        name: 'relay-d',
        apiKey: 'sk-new',
        baseUrl: 'https://same.example.com/v1'
      }
    ]);

    expect(imported.map((account) => account.name)).toEqual(['relay-d']);
    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-a', 'relay-d']);
  });

  it('treats the same relay key with a different model as a different credential', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-same',
      baseUrl: 'https://same.example.com/v1',
      model: 'gpt-5.1-codex'
    });

    const imported = await mergeImportedAccounts(accountsPath, [
      {
        apiKey: 'sk-same',
        baseUrl: 'https://same.example.com/v1',
        model: 'gpt-5.2'
      }
    ]);

    expect(imported[0]).toMatchObject({
      name: 'same-example-com-1',
      model: 'gpt-5.2'
    });
  });

  it('validates URLs and keys', async () => {
    await expect(
      addAccount(accountsPath, {
        name: 'relay-a',
        apiKey: '',
        baseUrl: 'not-a-url'
      })
    ).rejects.toThrow(/invalid account/i);
  });

  it('repairs preferred account after remove', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://relay-a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://relay-b.example.com/v1'
    });
    await setPreferredAccount(accountsPath, 'relay-a');

    await removeAccount(accountsPath, 'relay-a');

    const file = await loadAccountsFile(accountsPath);
    expect(file.preferred).toBe('relay-b');
  });

  it('imports accounts from a top-level json array', async () => {
    const importPath = join(tmpDir, 'data.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1',
          model: 'gpt-5.1-codex'
        },
        {
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1'
        }
      ]),
      'utf8'
    );

    const accounts = await importAccountsFromFile(importPath);

    expect(accounts).toEqual([
      {
        name: 'relay-a',
        apiKey: 'sk-a',
        baseUrl: 'https://a.example.com/v1',
        model: 'gpt-5.1-codex'
      },
      {
        apiKey: 'sk-b',
        baseUrl: 'https://b.example.com/v1'
      }
    ]);
  });

  it('generates non-conflicting names for nameless imported accounts', async () => {
    await addAccount(accountsPath, {
      name: 'relay-example-com-1',
      apiKey: 'sk-existing',
      baseUrl: 'https://relay.example.com/v1'
    });

    const imported = await mergeImportedAccounts(accountsPath, [
      {
        apiKey: 'sk-a',
        baseUrl: 'https://relay.example.com/v1'
      },
      {
        apiKey: 'sk-b',
        baseUrl: 'https://relay.example.com/v1'
      }
    ]);

    expect(imported.map((account) => account.name)).toEqual([
      'relay-example-com-2',
      'relay-example-com-3'
    ]);
    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual([
      'relay-example-com-1',
      'relay-example-com-2',
      'relay-example-com-3'
    ]);
  });

  it('rejects wrapped import objects in favor of top-level arrays', async () => {
    const importPath = join(tmpDir, 'wrapped.json');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify({
        accounts: [
          {
            baseUrl: 'https://relay.example.com/v1',
            apiKey: 'sk-a'
          }
        ]
      }),
      'utf8'
    );

    await expect(importAccountsFromFile(importPath)).rejects.toThrow(/top-level array/i);
  });

  it('rejects non-json import files', async () => {
    const importPath = join(tmpDir, 'data.txt');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(importPath, 'https://text.example.com/v1,sk-text,relay-text\n', 'utf8');

    await expect(importAccountsFromFile(importPath)).rejects.toThrow(/valid JSON/i);
  });

  it('rejects nested key-pool json shapes', async () => {
    const importPath = join(tmpDir, 'nested.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          baseUrl: 'https://relay-a.example.com/v1',
          keys: ['sk-a1', 'sk-a2']
        }
      ]),
      'utf8'
    );

    await expect(importAccountsFromFile(importPath)).rejects.toThrow(/invalid import file/i);
  });

  it('rejects invalid json account records', async () => {
    const importPath = join(tmpDir, 'invalid.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: '',
          apiKey: '',
          baseUrl: 'not-a-url'
        }
      ]),
      'utf8'
    );

    await expect(importAccountsFromFile(importPath)).rejects.toThrow(/invalid import file/i);
  });

  it('rejects duplicate names already stored in accounts json', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      accountsPath,
      JSON.stringify({
        version: 1,
        customQuotaPatterns: [],
        accounts: [
          {
            name: 'relay-a',
            apiKey: 'sk-a',
            baseUrl: 'https://a.example.com/v1',
            addedAt: '2026-05-18T00:00:00.000Z'
          },
          {
            name: 'relay-a',
            apiKey: 'sk-b',
            baseUrl: 'https://b.example.com/v1',
            addedAt: '2026-05-18T00:00:00.000Z'
          }
        ]
      }),
      'utf8'
    );

    await expect(loadAccountsFile(accountsPath)).rejects.toThrow(/duplicate account/i);
  });

  it('rejects malformed stored accounts json', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      accountsPath,
      JSON.stringify({
        version: 1,
        customQuotaPatterns: [],
        accounts: [
          {
            name: 'relay-a',
            apiKey: '',
            baseUrl: 'not-a-url',
            addedAt: 'not-a-date'
          }
        ]
      }),
      'utf8'
    );

    await expect(loadAccountsFile(accountsPath)).rejects.toThrow(/invalid accounts file/i);
  });

  it('removes preferred account when the store becomes empty', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    await removeAccount(accountsPath, 'relay-a');

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts).toEqual([]);
    expect(file.preferred).toBeUndefined();
  });

  it('returns no candidates from an empty json array', async () => {
    const importPath = join(tmpDir, 'empty.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(importPath, '[]', 'utf8');

    await expect(importAccountsFromFile(importPath)).resolves.toEqual([]);
  });

  it('returns no imported accounts when every candidate is already present', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const imported = await mergeImportedAccounts(accountsPath, [
      {
        name: 'relay-a',
        apiKey: 'sk-a',
        baseUrl: 'https://a.example.com/v1'
      }
    ]);

    expect(imported).toEqual([]);
  });

  it('keeps existing preferred account when saving a file with an invalid preferred value', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    const file = await loadAccountsFile(accountsPath);

    await saveAccountsFile(accountsPath, {
      ...file,
      preferred: 'missing'
    });

    const saved = await loadAccountsFile(accountsPath);
    expect(saved.preferred).toBe('relay-a');
  });

  it('keeps preferred account when overwriting an existing account', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });
    await setPreferredAccount(accountsPath, 'relay-b');
    await addAccount(
      accountsPath,
      {
        name: 'relay-a',
        apiKey: 'sk-a2',
        baseUrl: 'https://a2.example.com/v1'
      },
      { overwrite: true }
    );

    const file = await loadAccountsFile(accountsPath);
    expect(file.preferred).toBe('relay-b');
    expect(file.accounts.find((account) => account.name === 'relay-a')?.apiKey).toBe('sk-a2');
  });

  it('writes pretty json', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://relay.example.com/v1'
    });

    await expect(readFile(accountsPath, 'utf8')).resolves.toContain('\n  "version": 1');
  });
});
