import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, readJsonFile } from '../src/utils/atomic.js';
import { withFileLock } from '../src/utils/lock.js';

const tmpDir = fileURLToPath(new URL('./tmp-atomic/', import.meta.url));

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('atomic utilities', () => {
  it('writes json atomically', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'state.json');

    await writeJsonAtomic(filePath, { value: 'ok' });

    await expect(readFile(filePath, 'utf8')).resolves.toContain('"value": "ok"');
  });

  it('reads json files', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'state.json');
    await writeJsonAtomic(filePath, { value: 1 });

    await expect(readJsonFile(filePath)).resolves.toEqual({ value: 1 });
  });

  it('serializes work with a file lock', async () => {
    const lockPath = join(tmpDir, 'store.lock');
    const events: string[] = [];
    let releaseFirst!: () => void;
    let first!: Promise<void>;
    const firstEntered = new Promise<void>((resolve) => {
      const releasePromise = new Promise<void>((release) => {
        releaseFirst = release;
      });
      first = withFileLock(lockPath, async () => {
        events.push('first-start');
        resolve();
        await releasePromise;
        events.push('first-end');
      });
    });

    await firstEntered;
    const second = withFileLock(lockPath, async () => {
      events.push('second-start');
      events.push('second-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['first-start']);
    releaseFirst();

    await Promise.all([first, second]);

    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('removes stale locks before acquiring', async () => {
    const lockPath = join(tmpDir, 'stale.lock');
    await mkdir(lockPath, { recursive: true });
    await utimes(lockPath, new Date('2026-05-19T00:00:00.000Z'), new Date('2026-05-19T00:00:00.000Z'));

    await expect(withFileLock(lockPath, async () => 'ok', {
      now: () => new Date('2026-05-19T00:01:00.000Z'),
      staleMs: 1,
      timeoutMs: 50,
      retryDelayMs: 1
    })).resolves.toBe('ok');
  });

  it('times out while waiting for a fresh lock', async () => {
    const lockPath = join(tmpDir, 'busy.lock');
    let currentMs = new Date('2026-05-19T00:00:00.000Z').getTime();
    await mkdir(lockPath, { recursive: true });
    await utimes(lockPath, new Date(currentMs), new Date(currentMs));

    await expect(withFileLock(lockPath, async () => 'never', {
      now: () => {
        currentMs += 10;
        return new Date(currentMs);
      },
      staleMs: 60_000,
      timeoutMs: 20,
      retryDelayMs: 1
    })).rejects.toThrow(/timed out/i);
  });
});
