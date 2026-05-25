import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/utils/lock.js';

const tmpDir = fileURLToPath(new URL('./tmp-lock/', import.meta.url));
const lockPath = join(tmpDir, 'store.lock');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('file lock', () => {
  it('creates an owner file while the lock is held and releases it afterwards', async () => {
    const result = await withFileLock(lockPath, async () => {
      const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
      expect(owner.pid).toBe(process.pid);
      return 'ok';
    });

    expect(result).toBe('ok');
    await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes stale locks before acquiring a new lock', async () => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), '{}', 'utf8');

    const result = await withFileLock(
      lockPath,
      async () => readFile(join(lockPath, 'owner.json'), 'utf8'),
      {
        staleMs: 1,
        retryDelayMs: 1,
        now: () => new Date('2099-01-01T00:00:00.000Z')
      }
    );

    expect(result).toContain(String(process.pid));
  });

  it('times out when a non-stale lock remains busy', async () => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), '{}', 'utf8');

    await expect(
      withFileLock(lockPath, async () => 'unreachable', {
        timeoutMs: 0,
        staleMs: Number.MAX_SAFE_INTEGER,
        retryDelayMs: 1,
        now: () => new Date()
      })
    ).rejects.toThrow(/timed out waiting/i);
  });
});
