import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic.js';
import type { AccountLease, PendingResume, StateFile } from '../types.js';

const accountLeaseSchema = z.object({
  accountName: z.string().trim().min(1),
  ownerId: z.string().trim().min(1),
  pid: z.number().int().min(0),
  cwd: z.string().trim().min(1).optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

const stateFileSchema = z.object({
  version: z.literal(1),
  currentIndex: z.number().int().min(0),
  lastSuccessfulAccount: z.string().trim().min(1).optional(),
  pendingResume: z.unknown().optional(),
  leases: z.record(z.string(), z.unknown()),
  updatedAt: z.string().optional()
}).strict();

const pendingResumeSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  updatedAt: z.string().datetime()
}).strict();

export async function loadStateFile(filePath: string): Promise<StateFile> {
  try {
    const parsed = await readJsonFile<unknown>(filePath);
    const result = normalizeStateFile(parsed);
    if (result.repaired) {
      await writeJsonAtomic(filePath, result.file);
    }
    return result.file;
  } catch (error) {
    if (isMissingFile(error)) {
      return createDefaultState();
    }
    throw error;
  }
}

export async function saveStateFile(filePath: string, state: StateFile): Promise<void> {
  await writeJsonAtomic(filePath, normalizeStateFile({ ...state, updatedAt: state.updatedAt || new Date().toISOString() }).file);
}

export function pruneExpiredLeases(state: StateFile, now: Date): StateFile {
  const nowMs = now.getTime();
  const entries = Object.entries(state.leases);
  const activeEntries = entries.filter(([, lease]) => new Date(lease.expiresAt).getTime() > nowMs);
  if (activeEntries.length === entries.length) {
    return state;
  }
  const leases = Object.fromEntries(activeEntries);
  return {
    ...state,
    leases
  };
}

export function createDefaultState(): StateFile {
  return {
    version: 1,
    currentIndex: 0,
    leases: {},
    updatedAt: new Date().toISOString()
  };
}

function normalizeStateFile(raw: unknown): { file: StateFile; repaired: boolean } {
  const result = stateFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid state file: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  let repaired = false;
  const leases: Record<string, AccountLease> = {};
  for (const [ownerId, rawLease] of Object.entries(result.data.leases)) {
    const lease = accountLeaseSchema.safeParse(rawLease);
    if (!lease.success) {
      repaired = true;
      continue;
    }
    leases[ownerId] = normalizeAccountLease(lease.data);
  }
  const updatedAt = normalizeIsoDate(result.data.updatedAt);
  if (updatedAt !== result.data.updatedAt) {
    repaired = true;
  }
  const state: StateFile = {
    version: 1,
    currentIndex: result.data.currentIndex,
    leases,
    updatedAt
  };
  if (result.data.lastSuccessfulAccount) {
    state.lastSuccessfulAccount = result.data.lastSuccessfulAccount;
  }
  if (result.data.pendingResume !== undefined) {
    const pendingResume = pendingResumeSchema.safeParse(result.data.pendingResume);
    if (pendingResume.success) {
      state.pendingResume = normalizePendingResume(pendingResume.data);
    } else {
      repaired = true;
    }
  }
  return { file: state, repaired };
}

type ParsedAccountLease = z.infer<typeof accountLeaseSchema>;

function normalizeAccountLease(lease: ParsedAccountLease): AccountLease {
  const normalized: AccountLease = {
    accountName: lease.accountName,
    ownerId: lease.ownerId,
    pid: lease.pid,
    startedAt: lease.startedAt,
    updatedAt: lease.updatedAt,
    expiresAt: lease.expiresAt
  };
  if (lease.cwd) {
    normalized.cwd = lease.cwd;
  }
  return normalized;
}

type ParsedPendingResume = z.infer<typeof pendingResumeSchema>;

function normalizePendingResume(pendingResume: ParsedPendingResume): PendingResume {
  const normalized: PendingResume = {
    prompt: pendingResume.prompt,
    updatedAt: pendingResume.updatedAt
  };
  if (pendingResume.sessionId) {
    normalized.sessionId = pendingResume.sessionId;
  }
  if (pendingResume.cwd) {
    normalized.cwd = pendingResume.cwd;
  }
  return normalized;
}

function normalizeIsoDate(value: unknown): string {
  return typeof value === 'string' && z.string().datetime().safeParse(value).success
    ? value
    : new Date().toISOString();
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
