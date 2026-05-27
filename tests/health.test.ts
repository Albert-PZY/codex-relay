import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAccountHealth,
  isAccountHealthy,
  loadHealthFile,
  recordAccountFailure,
  recordAccountSuccess,
  resetAccountCooldown,
  resetAllAccountCooldowns,
  retireExpiredHealthAccounts
} from '../src/core/health.js';
import type { AccountsFile } from '../src/types.js';

const tmpDir = fileURLToPath(new URL('./tmp-health/', import.meta.url));
const healthPath = join(tmpDir, 'health.json');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('health store', () => {
  it('loads a default health file when missing', async () => {
    const health = await loadHealthFile(healthPath);

    expect(health).toMatchObject({
      version: 1,
      accounts: {},
      retired: []
    });
  });

  it('records quota failures with a cooldown window', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      status: 'cooldown',
      reason: 'quota',
      firstFailedAt: '2026-05-19T00:00:00.000Z',
      lastFailedAt: '2026-05-19T00:00:00.000Z',
      cooldownUntil: '2026-05-19T00:30:00.000Z',
      consecutiveFailures: 1,
      cooldownCount: 1,
      baseUrl: 'https://a.example.com/v1'
    });
  });

  it('uses the fixed 30 minute cooldown even when retry-after metadata is present', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      retryAfterMs: 30_000,
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']?.cooldownUntil).toBe('2026-05-19T00:30:00.000Z');
  });

  it('keeps the first failure timestamp across repeated failures', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'server',
      now: new Date('2026-05-19T00:00:00.000Z')
    });
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-20T00:00:00.000Z')
    });

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      reason: 'quota',
      firstFailedAt: '2026-05-19T00:00:00.000Z',
      lastFailedAt: '2026-05-20T00:00:00.000Z',
      consecutiveFailures: 2,
      cooldownCount: 2
    });
    expect(health.accounts['relay-a']?.lastSuccessAt).toBeUndefined();
  });

  it('preserves known base url and last success when recording later failures', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'server',
      now: new Date('2026-05-19T00:00:00.000Z')
    });
    await recordAccountSuccess(healthPath, 'relay-a', new Date('2026-05-19T00:02:00.000Z'));
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      reason: 'rate_limit',
      now: new Date('2026-05-19T00:03:00.000Z')
    });

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      baseUrl: 'https://a.example.com/v1',
      lastSuccessAt: '2026-05-19T00:02:00.000Z',
      reason: 'rate_limit'
    });
  });

  it('resets failures after a successful account run', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    await recordAccountSuccess(healthPath, 'relay-a', new Date('2026-05-19T01:00:00.000Z'));

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      status: 'active',
      lastSuccessAt: '2026-05-19T01:00:00.000Z',
      consecutiveFailures: 0,
      cooldownCount: 0
    });
    expect(health.accounts['relay-a']?.cooldownUntil).toBeUndefined();
    expect(health.accounts['relay-a']?.firstFailedAt).toBeUndefined();
  });

  it('retires accounts after ten cooldowns', async () => {
    const accountsFile: AccountsFile = {
      version: 1,
      preferred: 'relay-a',
      customQuotaPatterns: [],
      accounts: [
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1',
          addedAt: '2026-05-10T00:00:00.000Z'
        },
        {
          name: 'relay-b',
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1',
          addedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    };
    for (let index = 0; index < 10; index += 1) {
      await recordAccountFailure(healthPath, {
        accountName: 'relay-a',
        apiKey: 'sk-a',
        baseUrl: 'https://a.example.com/v1',
        reason: 'auth',
        now: new Date(`2026-05-19T00:${String(index).padStart(2, '0')}:00.000Z`)
      });
    }

    const result = await retireExpiredHealthAccounts(
      healthPath,
      accountsFile,
      new Date('2026-05-19T00:10:00.000Z')
    );

    expect(result.retiredNames).toEqual(['relay-a']);
    expect(result.accountsFile.accounts.map((account) => account.name)).toEqual(['relay-b']);
    expect(result.accountsFile.preferred).toBe('relay-b');
    expect(result.health.accounts['relay-a']).toBeUndefined();
    expect(result.health.retired[0]).toMatchObject({
      name: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'auth',
      firstFailedAt: '2026-05-19T00:00:00.000Z',
      removedAt: '2026-05-19T00:10:00.000Z',
      cooldownCount: 10
    });
  });

  it('keeps accounts with fewer than ten cooldowns', async () => {
    const accountsFile: AccountsFile = {
      version: 1,
      preferred: 'relay-a',
      customQuotaPatterns: [],
      accounts: [
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1',
          addedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    };
    for (let index = 0; index < 9; index += 1) {
      await recordAccountFailure(healthPath, {
        accountName: 'relay-a',
        apiKey: 'sk-a',
        baseUrl: 'https://a.example.com/v1',
        reason: 'auth',
        now: new Date(`2026-05-19T00:${String(index).padStart(2, '0')}:00.000Z`)
      });
    }

    const result = await retireExpiredHealthAccounts(
      healthPath,
      accountsFile,
      new Date('2026-05-19T00:10:00.000Z')
    );

    expect(result.retiredNames).toEqual([]);
    expect(result.accountsFile.accounts.map((account) => account.name)).toEqual(['relay-a']);
  });

  it('keeps accounts when no health record has crossed the retirement window', async () => {
    const accountsFile: AccountsFile = {
      version: 1,
      preferred: 'relay-a',
      customQuotaPatterns: [],
      accounts: [
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1',
          addedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    };

    const result = await retireExpiredHealthAccounts(
      healthPath,
      accountsFile,
      new Date('2026-05-19T00:00:01.000Z')
    );

    expect(result.retiredNames).toEqual([]);
    expect(result.accountsFile.accounts.map((account) => account.name)).toEqual(['relay-a']);
  });

  it('shares cooldown state across accounts with the same relay key', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      apiKey: 'sk-same',
      baseUrl: 'https://same.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    const health = await loadHealthFile(healthPath);
    const duplicateAccount = {
      name: 'relay-duplicate',
      apiKey: 'sk-same',
      baseUrl: 'https://same.example.com/v1',
      addedAt: '2026-05-19T00:00:00.000Z'
    };

    expect(getAccountHealth(duplicateAccount, health)).toMatchObject({
      status: 'cooldown',
      reason: 'quota',
      cooldownUntil: '2026-05-19T00:30:00.000Z'
    });
  });

  it('treats cooldown records without an expiry as unavailable', async () => {
    const health = {
      version: 1 as const,
      accounts: {
        'relay-a': {
          status: 'cooldown' as const,
          reason: 'unknown' as const,
          consecutiveFailures: 1,
          cooldownCount: 1
        }
      },
      retired: [],
      updatedAt: '2026-05-19T00:00:00.000Z'
    };

    expect(isAccountHealthy('relay-a', health, new Date('2026-05-19T00:31:00.000Z'))).toBe(false);
  });

  it('resets cooldown counts for one account credential', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    await resetAccountCooldown(
      healthPath,
      {
        name: 'relay-a',
        apiKey: 'sk-a',
        baseUrl: 'https://a.example.com/v1',
        addedAt: '2026-05-19T00:00:00.000Z'
      },
      new Date('2026-05-19T00:05:00.000Z')
    );

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      status: 'active',
      consecutiveFailures: 0,
      cooldownCount: 0,
      lastSuccessAt: '2026-05-19T00:05:00.000Z'
    });
    expect(health.accounts['relay-a']?.cooldownUntil).toBeUndefined();
  });

  it('resets cooldown counts for all account credentials', async () => {
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });
    await recordAccountFailure(healthPath, {
      accountName: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1',
      reason: 'auth',
      now: new Date('2026-05-19T00:01:00.000Z')
    });

    await resetAllAccountCooldowns(
      healthPath,
      [
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1',
          addedAt: '2026-05-19T00:00:00.000Z'
        },
        {
          name: 'relay-b',
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1',
          addedAt: '2026-05-19T00:00:00.000Z'
        }
      ],
      new Date('2026-05-19T00:05:00.000Z')
    );

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({ status: 'active', cooldownCount: 0 });
    expect(health.accounts['relay-b']).toMatchObject({ status: 'active', cooldownCount: 0 });
  });

  it('rejects malformed health files', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      healthPath,
      JSON.stringify({
        version: 1,
        accounts: {
          'relay-a': {
            status: 'bad',
            consecutiveFailures: -1
          }
        },
        retired: [],
        updatedAt: 'not-a-date'
      }),
      'utf8'
    );

    await expect(loadHealthFile(healthPath)).rejects.toThrow(/invalid health file/i);
  });

  it('rejects unknown health fields', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      healthPath,
      JSON.stringify({
        version: 1,
        accounts: {},
        retired: [],
        staleField: true,
        updatedAt: '2026-05-19T00:00:00.000Z'
      }),
      'utf8'
    );

    await expect(loadHealthFile(healthPath)).rejects.toThrow(/invalid health file/i);
  });
});
