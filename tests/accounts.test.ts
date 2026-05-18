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

  it('writes pretty json', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://relay.example.com/v1'
    });

    await expect(readFile(accountsPath, 'utf8')).resolves.toContain('\n  "version": 1');
  });
});
