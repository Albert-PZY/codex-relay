import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 50;

export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await task();
  } finally {
    await release();
  }
}

async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();

  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: now().toISOString()
      }), 'utf8');
      return async () => {
        await rm(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      };
    } catch (error) {
      if (!isLockBusyError(error)) {
        throw error;
      }
      await removeStaleLock(lockPath, staleMs, now);
      if (now().getTime() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for codex-relay lock: ${lockPath}`);
      }
      await delay(retryDelayMs);
    }
  }
}

async function removeStaleLock(lockPath: string, staleMs: number, now: () => Date): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    if (now().getTime() - lockStat.mtimeMs >= staleMs) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isLockBusyError(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(String(error.code));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
