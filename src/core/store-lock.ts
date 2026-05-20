import { dirname, join } from 'node:path';
import { withFileLock } from '../utils/lock.js';
import type { DataPaths } from '../utils/paths.js';

type LockPaths = Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'lock'>>;

export async function withStoreLock<T>(paths: LockPaths, task: () => Promise<T>): Promise<T> {
  return withFileLock(resolveStoreLockPath(paths), task);
}

export function resolveStoreLockPath(paths: LockPaths): string {
  return paths.lock ?? join(dirname(paths.state), 'store.lock');
}
