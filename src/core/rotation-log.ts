import { readFile } from 'node:fs/promises';
import { writeTextAtomic } from '../utils/atomic.js';
import type { HealthFailureReason } from '../types.js';

const KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export interface RotationLogEntry {
  at: Date;
  from: string;
  to?: string;
  reason: HealthFailureReason;
  resumeMode: 'session';
  sessionId: string;
}

export async function appendRotationLog(filePath: string, entry: RotationLogEntry): Promise<void> {
  const cutoffMs = entry.at.getTime() - KEEP_FOR_MS;
  const existing = await readRotationLog(filePath);
  const kept = existing.filter((line) => {
    const parsed = parseRotationLogTimestamp(line);
    return Number.isFinite(parsed) && parsed >= cutoffMs;
  });
  kept.push(formatRotationLogEntry(entry));
  await writeTextAtomic(filePath, `${kept.join('\n')}\n`);
}

async function readRotationLog(filePath: string): Promise<string[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function formatRotationLogEntry(entry: RotationLogEntry): string {
  return JSON.stringify({
    timestamp: entry.at.toISOString(),
    event: 'account_rotation',
    sessionId: entry.sessionId,
    fromAccount: entry.from,
    toAccount: entry.to ?? null,
    reason: entry.reason,
    resumeMode: entry.resumeMode
  });
}

function parseRotationLogTimestamp(line: string): number {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown; at?: unknown };
    const timestamp = typeof parsed.timestamp === 'string'
      ? parsed.timestamp
      : typeof parsed.at === 'string'
        ? parsed.at
        : undefined;
    return timestamp ? Date.parse(timestamp) : Number.NaN;
  } catch {
    const timestampEnd = line.indexOf(' ');
    const timestamp = timestampEnd === -1 ? line : line.slice(0, timestampEnd);
    return Date.parse(timestamp);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
