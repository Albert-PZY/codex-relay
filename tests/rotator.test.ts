import { describe, expect, it } from 'vitest';
import type { AccountsFile, StateFile } from '../src/types.js';
import { chooseNextAccount, buildRotationOrder } from '../src/core/rotator.js';

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
});
