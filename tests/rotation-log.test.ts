import { readFile, rm, writeFile } from 'node:fs/promises';
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
  it('writes structured entries with the active session id', async () => {
    await appendRotationLog(logPath, {
      at: new Date('2026-05-21T00:00:00.000Z'),
      from: 'relay-a',
      to: 'relay-b',
      reason: 'auth',
      resumeMode: 'session',
      sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1'
    });

    const log = await readFile(logPath, 'utf8');
    expect(JSON.parse(log.trim())).toEqual({
      timestamp: '2026-05-21T00:00:00.000Z',
      event: 'account_rotation',
      sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
      fromAccount: 'relay-a',
      toAccount: 'relay-b',
      reason: 'auth',
      resumeMode: 'session'
    });
  });

  it('keeps only the last seven days of log entries', async () => {
    await appendRotationLog(logPath, {
      at: new Date('2026-05-01T00:00:00.000Z'),
      from: 'relay-old',
      to: 'relay-b',
      reason: 'quota',
      resumeMode: 'session',
      sessionId: 'old-session'
    });

    await appendRotationLog(logPath, {
      at: new Date('2026-05-21T00:00:00.000Z'),
      from: 'relay-a',
      to: 'relay-b',
      reason: 'quota',
      resumeMode: 'session',
      sessionId: 'session-a'
    });

    await appendRotationLog(logPath, {
      at: new Date('2026-05-28T00:00:00.000Z'),
      from: 'relay-c',
      to: 'relay-d',
      reason: 'server',
      resumeMode: 'session',
      sessionId: 'session-c'
    });

    const log = await readFile(logPath, 'utf8');
    const entries = log.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { fromAccount: string; toAccount: string; sessionId: string });
    expect(entries).not.toContainEqual(expect.objectContaining({ fromAccount: 'relay-old', toAccount: 'relay-b' }));
    expect(entries).toContainEqual(expect.objectContaining({ fromAccount: 'relay-a', toAccount: 'relay-b', sessionId: 'session-a' }));
    expect(entries).toContainEqual(expect.objectContaining({ fromAccount: 'relay-c', toAccount: 'relay-d', sessionId: 'session-c' }));
  });

  it('keeps old plain-text log entries only when they are inside the retention window', async () => {
    await appendRotationLog(logPath, {
      at: new Date('2026-05-28T00:00:00.000Z'),
      from: 'relay-a',
      to: 'relay-b',
      reason: 'auth',
      resumeMode: 'session',
      sessionId: 'session-a'
    });

    const existing = [
      '2026-05-01T00:00:00.000Z relay-old -> relay-b reason=quota resume=session',
      '2026-05-25T00:00:00.000Z relay-text -> relay-json reason=auth resume=session',
      await readFile(logPath, 'utf8')
    ].join('\n');
    await writeFile(logPath, existing, 'utf8');

    await appendRotationLog(logPath, {
      at: new Date('2026-05-28T00:01:00.000Z'),
      from: 'relay-c',
      to: 'relay-d',
      reason: 'server',
      resumeMode: 'session',
      sessionId: 'session-c'
    });

    const log = await readFile(logPath, 'utf8');
    expect(log).not.toContain('relay-old -> relay-b');
    expect(log).toContain('relay-text -> relay-json');
    expect(log).toContain('"sessionId":"session-c"');
  });
});
