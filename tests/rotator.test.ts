import { describe, expect, it } from 'vitest';
import type { AccountsFile, HealthFile, StateFile } from '../src/types.js';
import { buildRotationOrder, isAccountAvailable } from '../src/core/rotator.js';

const accounts: AccountsFile = {
  version: 1,
  preferred: 'relay-b',
  customQuotaPatterns: [],
  accounts: [
    {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1',
      addedAt: '2026-05-18T00:00:00.000Z'
    },
    {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1',
      addedAt: '2026-05-18T00:00:00.000Z'
    },
    {
      name: 'relay-c',
      apiKey: 'sk-c',
      baseUrl: 'https://c.example.com/v1',
      addedAt: '2026-05-18T00:00:00.000Z'
    }
  ]
};

describe('rotation', () => {
  it('prefers the configured starting account first', () => {
    expect(buildRotationOrder(accounts, state())).toEqual(['relay-b', 'relay-c', 'relay-a']);
  });

  it('returns an empty rotation order for an empty account pool', () => {
    expect(buildRotationOrder({ version: 1, customQuotaPatterns: [], accounts: [] }, state())).toEqual([]);
  });

  it('uses requested account before preferred and state index', () => {
    expect(buildRotationOrder(accounts, state(), 'relay-c')).toEqual(['relay-c', 'relay-a', 'relay-b']);
  });

  it('uses health cooldown as the only availability gate', () => {
    const health: HealthFile = {
      version: 1,
      accounts: {
        'relay-a': {
          status: 'cooldown',
          cooldownUntil: '2099-01-01T00:00:00.000Z',
          consecutiveFailures: 1
        },
        'relay-b': {
          status: 'cooldown',
          cooldownUntil: '2026-05-18T00:00:00.000Z',
          consecutiveFailures: 1
        }
      },
      retired: [],
      updatedAt: '2026-05-18T00:00:00.000Z'
    };

    expect(isAccountAvailable('relay-a', new Date('2026-05-19T00:00:00.000Z'), health)).toBe(false);
    expect(isAccountAvailable('relay-b', new Date('2026-05-19T00:00:00.000Z'), health)).toBe(true);
    expect(isAccountAvailable('relay-c', new Date('2026-05-19T00:00:00.000Z'), health)).toBe(true);
  });
});

function state(): StateFile {
  return {
    version: 1,
    currentIndex: 0,
    leases: {},
    updatedAt: '2026-05-18T00:00:00.000Z'
  };
}
