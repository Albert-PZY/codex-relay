import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStateFile,
  pruneExpiredLeases,
  saveStateFile
} from '../src/core/state.js';

const tmpDir = fileURLToPath(new URL('./tmp-state/', import.meta.url));
const statePath = join(tmpDir, 'state.json');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('state store', () => {
  it('loads default state when missing', async () => {
    const state = await loadStateFile(statePath);

    expect(state).toMatchObject({
      version: 1,
      currentIndex: 0,
      leases: {}
    });
  });

  it('saves state files', async () => {
    const state = await loadStateFile(statePath);
    state.currentIndex = 2;

    await saveStateFile(statePath, state);

    await expect(loadStateFile(statePath)).resolves.toMatchObject({
      currentIndex: 2
    });
  });

  it('persists successful account fields', async () => {
    const state = await loadStateFile(statePath);
    await saveStateFile(statePath, {
      ...state,
      currentIndex: 1,
      lastSuccessfulAccount: 'relay-b'
    });

    const saved = await loadStateFile(statePath);
    expect(saved.lastSuccessfulAccount).toBe('relay-b');
    expect(saved.currentIndex).toBe(1);
  });

  it('persists pending resume metadata', async () => {
    const state = await loadStateFile(statePath);
    await saveStateFile(statePath, {
      ...state,
      pendingResume: {
        sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
        prompt: 'Continue',
        cwd: 'C:/workspace/project',
        updatedAt: '2026-05-23T00:00:00.000Z'
      }
    });

    const saved = await loadStateFile(statePath);
    expect(saved.pendingResume).toMatchObject({
      sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
      prompt: 'Continue',
      cwd: 'C:/workspace/project'
    });
  });

  it('repairs pending resume metadata without an explicit session id', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: 0,
        pendingResume: {
          prompt: 'Continue',
          cwd: 'C:/workspace/project',
          updatedAt: '2026-05-23T00:00:00.000Z'
        },
        leases: {},
        updatedAt: '2026-05-23T00:00:00.000Z'
      }),
      'utf8'
    );

    const saved = await loadStateFile(statePath);
    expect(saved.pendingResume).toBeUndefined();
  });

  it('saves a state file with a generated timestamp when updatedAt is empty', async () => {
    const state = await loadStateFile(statePath);
    state.updatedAt = '';

    await saveStateFile(statePath, state);

    const saved = await loadStateFile(statePath);
    expect(saved.updatedAt).toMatch(/T/);
  });

  it('repairs malformed stored lease entries and invalid timestamps', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: 0,
        leases: {
          bad: {
            accountName: 'relay-a',
            ownerId: 'bad',
            pid: 1,
            startedAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
            expiresAt: ''
          }
        },
        updatedAt: 'not-a-date'
      }),
      'utf8'
    );

    const state = await loadStateFile(statePath);
    expect(state.leases).toEqual({});
    expect(state.updatedAt).toMatch(/T/);
  });

  it('rejects unknown state fields', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: 0,
        leases: {},
        staleField: true,
        updatedAt: '2026-05-19T00:00:00.000Z'
      }),
      'utf8'
    );

    await expect(loadStateFile(statePath)).rejects.toThrow(/invalid state file/i);
  });

  it('prunes expired account leases', async () => {
    const state = await loadStateFile(statePath);
    const pruned = pruneExpiredLeases({
      ...state,
      leases: {
        old: {
          accountName: 'relay-a',
          ownerId: 'old',
          pid: 1,
          startedAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T00:00:00.000Z',
          expiresAt: '2026-05-19T00:01:00.000Z'
        },
        active: {
          accountName: 'relay-b',
          ownerId: 'active',
          pid: 2,
          startedAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T00:01:00.000Z',
          expiresAt: '2026-05-19T00:03:00.000Z'
        }
      }
    }, new Date('2026-05-19T00:02:00.000Z'));

    expect(Object.keys(pruned.leases)).toEqual(['active']);
  });

  it('saves account leases', async () => {
    const lease = {
      accountName: 'relay-a',
      ownerId: 'owner-a',
      pid: 1,
      startedAt: '2026-05-19T00:00:00.000Z',
      updatedAt: '2026-05-19T00:00:00.000Z',
      expiresAt: '2026-05-19T00:02:00.000Z'
    };
    const state = await loadStateFile(statePath);

    await saveStateFile(statePath, {
      ...state,
      leases: {
        [lease.ownerId]: lease
      },
      updatedAt: lease.updatedAt
    });

    await expect(loadStateFile(statePath)).resolves.toMatchObject({
      leases: {
        'owner-a': lease
      }
    });
  });
});
