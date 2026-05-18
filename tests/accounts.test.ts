import { afterEach, describe, expect, it } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAccount,
  importAccountsFromText,
  listAccounts,
  loadAccountsFile,
  removeAccount,
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

  it('parses json and text imports', () => {
    const json = importAccountsFromText(
      JSON.stringify({
        accounts: [
          {
            name: 'relay-json',
            apiKey: 'sk-json',
            baseUrl: 'https://json.example.com/v1'
          }
        ]
      })
    );
    const text = importAccountsFromText('https://text.example.com/v1,sk-text,relay-text');

    expect(json[0]?.name).toBe('relay-json');
    expect(text[0]).toMatchObject({
      name: 'relay-text',
      apiKey: 'sk-text',
      baseUrl: 'https://text.example.com/v1'
    });
  });

  it('expands relay pools with multiple keys per base url', () => {
    const accounts = importAccountsFromText(
      JSON.stringify({
        relays: [
          {
            name: 'relay-a',
            baseUrl: 'https://relay-a.example.com/v1',
            apiKeys: ['sk-a1', 'sk-a2']
          },
          {
            name: 'relay-b',
            baseUrl: 'https://relay-b.example.com/v1',
            keys: ['sk-b1']
          }
        ]
      })
    );

    expect(accounts).toEqual([
      {
        name: 'relay-a-1',
        apiKey: 'sk-a1',
        baseUrl: 'https://relay-a.example.com/v1'
      },
      {
        name: 'relay-a-2',
        apiKey: 'sk-a2',
        baseUrl: 'https://relay-a.example.com/v1'
      },
      {
        name: 'relay-b-1',
        apiKey: 'sk-b1',
        baseUrl: 'https://relay-b.example.com/v1'
      }
    ]);
  });

  it('parses direct json arrays and pools field', () => {
    const direct = importAccountsFromText(
      JSON.stringify([
        {
          name: 'direct',
          apiKey: 'sk-direct',
          baseUrl: 'https://direct.example.com/v1'
        }
      ])
    );
    const pools = importAccountsFromText(
      JSON.stringify({
        pools: [
          {
            name: 'pool',
            baseUrl: 'https://pool.example.com/v1',
            keys: ['sk-pool']
          }
        ]
      })
    );

    expect(direct[0]?.name).toBe('direct');
    expect(pools[0]).toMatchObject({
      name: 'pool-1',
      apiKey: 'sk-pool',
      baseUrl: 'https://pool.example.com/v1'
    });
  });

  it('rejects relay pools with empty key arrays', () => {
    expect(() =>
      importAccountsFromText(
        JSON.stringify({
          relays: [
            {
              name: 'empty',
              baseUrl: 'https://empty.example.com/v1',
              keys: []
            }
          ]
        })
      )
    ).toThrow(/key/i);
  });

  it('rejects key-only text imports because base url is required', () => {
    expect(() => importAccountsFromText('sk-key-without-base-url')).toThrow(/base url/i);
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
