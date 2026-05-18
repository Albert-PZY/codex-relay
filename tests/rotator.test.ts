import { describe, expect, it } from 'vitest';
import type { AccountsFile, StateFile } from '../src/types.js';
import { chooseNextAccount, buildRotationOrder, isAccountAvailable } from '../src/core/rotator.js';

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
    const state: StateFile = {
      version: 1,
      currentIndex: 0,
      retryAvailability: {},
      updatedAt: '2026-05-18T00:00:00.000Z'
    };

    expect(buildRotationOrder(accounts, state)).toEqual(['relay-b', 'relay-c', 'relay-a']);
  });

  it('skips unavailable accounts', () => {
    const state: StateFile = {
      version: 1,
      currentIndex: 0,
      retryAvailability: {
        'relay-b': {
          displayText: '11:10 PM',
          availableAt: '2099-01-01T23:10:00.000Z'
        }
      },
      updatedAt: '2026-05-18T00:00:00.000Z'
    };

    expect(chooseNextAccount(accounts, state, 'relay-a', new Date('2026-05-18T00:00:00.000Z'))).toBe('relay-a');
    expect(chooseNextAccount(accounts, state, 'relay-b', new Date('2026-05-18T00:00:00.000Z'))).toBe('relay-c');
  });

  it('treats expired retry windows as available', () => {
    const state: StateFile = {
      version: 1,
      currentIndex: 0,
      retryAvailability: {
        'relay-a': {
          displayText: 'old',
          availableAt: '2026-05-18T00:00:00.000Z'
        }
      },
      updatedAt: '2026-05-18T00:00:00.000Z'
    };

    expect(isAccountAvailable('relay-a', state, new Date('2026-05-19T00:00:00.000Z'))).toBe(true);
  });

  it('returns undefined when all accounts are unavailable', () => {
    const state: StateFile = {
      version: 1,
      currentIndex: 0,
      retryAvailability: {
        'relay-a': { displayText: 'future', availableAt: '2099-01-01T00:00:00.000Z' },
        'relay-b': { displayText: 'future', availableAt: '2099-01-01T00:00:00.000Z' },
        'relay-c': { displayText: 'future', availableAt: '2099-01-01T00:00:00.000Z' }
      },
      updatedAt: '2026-05-18T00:00:00.000Z'
    };

    expect(chooseNextAccount(accounts, state, undefined, new Date('2026-05-19T00:00:00.000Z'))).toBeUndefined();
  });
});
