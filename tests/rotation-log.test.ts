import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRotationLog } from '../src/core/rotation-log.js';

const tmpDir = fileURLToPath(new URL('./tmp-rotation-log/', import.meta.url));
const logPath = join(tmpDir, 'rotation.log');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('rotation log', () => {
  it('writes concise entries with the active resume mode', async () => {
    await appendRotationLog(logPath, {
      at: new Date('2026-05-21T00:00:00.000Z'),
      from: 'relay-a',
      to: 'relay-b',
      reason: 'auth',
      resumeMode: 'session'
    });

    const log = await readFile(logPath, 'utf8');
    expect(log).toBe('2026-05-21T00:00:00.000Z relay-a -> relay-b reason=auth resume=session\n');
  });

  it('keeps only the last seven days of log entries', async () => {
    await appendRotationLog(logPath, {
      at: new Date('2026-05-01T00:00:00.000Z'),
      from: 'relay-old',
      to: 'relay-b',
      reason: 'quota',
      resumeMode: 'session'
    });

    await appendRotationLog(logPath, {
      at: new Date('2026-05-21T00:00:00.000Z'),
      from: 'relay-a',
      to: 'relay-b',
      reason: 'quota',
      resumeMode: 'session'
    });

    await appendRotationLog(logPath, {
      at: new Date('2026-05-28T00:00:00.000Z'),
      from: 'relay-c',
      to: 'relay-d',
      reason: 'server',
      resumeMode: 'session'
    });

    const log = await readFile(logPath, 'utf8');
    expect(log).not.toContain('relay-old -> relay-b');
    expect(log).toContain('relay-a -> relay-b');
    expect(log).toContain('relay-c -> relay-d');
  });
});
