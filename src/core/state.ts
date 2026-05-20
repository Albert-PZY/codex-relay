import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic.js';
import type { AccountLease, StateFile } from '../types.js';

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
  leases: z.record(z.string(), accountLeaseSchema),
  updatedAt: z.string().datetime()
}).strict();

export async function loadStateFile(filePath: string): Promise<StateFile> {
  try {
    const parsed = await readJsonFile<unknown>(filePath);
    return validateStateFile(parsed);
  } catch (error) {
    if (isMissingFile(error)) {
      return createDefaultState();
    }
    throw error;
  }
}

export async function saveStateFile(filePath: string, state: StateFile): Promise<void> {
  await writeJsonAtomic(filePath, validateStateFile({ ...state, updatedAt: state.updatedAt || new Date().toISOString() }));
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

function validateStateFile(raw: unknown): StateFile {
  const result = stateFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid state file: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  const state: StateFile = {
    version: 1,
    currentIndex: result.data.currentIndex,
    leases: Object.fromEntries(
      Object.entries(result.data.leases).map(([ownerId, lease]) => [ownerId, normalizeAccountLease(lease)])
    ),
    updatedAt: result.data.updatedAt
  };
  if (result.data.lastSuccessfulAccount) {
    state.lastSuccessfulAccount = result.data.lastSuccessfulAccount;
  }
  return state;
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

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
