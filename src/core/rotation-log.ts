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
}

export async function appendRotationLog(filePath: string, entry: RotationLogEntry): Promise<void> {
  const cutoffMs = entry.at.getTime() - KEEP_FOR_MS;
  const existing = await readRotationLog(filePath);
  const kept = existing.filter((line) => {
    const timestamp = line.slice(0, line.indexOf(' '));
    const parsed = Date.parse(timestamp);
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
  const target = entry.to ?? 'none';
  return `${entry.at.toISOString()} ${entry.from} -> ${target} reason=${entry.reason} resume=${entry.resumeMode}`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
