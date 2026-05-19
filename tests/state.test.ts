import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStateFile,
  markRetryAvailability,
  saveStateFile,
  updateSuccessfulAccount
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
      retryAvailability: {}
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

  it('tracks successful account and retry availability', async () => {
    await updateSuccessfulAccount(statePath, 'relay-b', 1);
    await markRetryAvailability(statePath, 'relay-a', {
      displayText: '11:10 PM',
      availableAt: '2026-01-01T23:10:00.000Z'
    });

    const state = await loadStateFile(statePath);
    expect(state.lastSuccessfulAccount).toBe('relay-b');
    expect(state.currentIndex).toBe(1);
    expect(state.retryAvailability['relay-a']?.displayText).toBe('11:10 PM');
  });

  it('saves a state file with a generated timestamp when updatedAt is empty', async () => {
    const state = await loadStateFile(statePath);
    state.updatedAt = '';

    await saveStateFile(statePath, state);

    const saved = await loadStateFile(statePath);
    expect(saved.updatedAt).toMatch(/T/);
  });

  it('rejects malformed state files', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: -1,
        retryAvailability: {},
        updatedAt: 'not-a-date'
      }),
      'utf8'
    );

    await expect(loadStateFile(statePath)).rejects.toThrow(/invalid state file/i);
  });

  it('creates retry availability entries with later timestamps', async () => {
    await markRetryAvailability(statePath, 'relay-a', {
      displayText: 'soon',
      availableAt: '2026-05-19T00:00:05.000Z'
    });

    const state = await loadStateFile(statePath);
    expect(state.retryAvailability['relay-a']?.availableAt).toBe('2026-05-19T00:00:05.000Z');
  });
});
