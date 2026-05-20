import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic.js';
import type { AccountLease, RetryAvailability, StateFile } from '../types.js';

const retryAvailabilitySchema = z.object({
  displayText: z.string().trim().min(1),
  availableAt: z.string().datetime()
});

const accountLeaseSchema = z.object({
  accountName: z.string().trim().min(1),
  ownerId: z.string().trim().min(1),
  pid: z.number().int().min(0),
  cwd: z.string().trim().min(1).optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

const stateFileSchema = z.object({
  version: z.literal(1),
  currentIndex: z.number().int().min(0),
  lastSuccessfulAccount: z.string().trim().min(1).optional(),
  retryAvailability: z.record(z.string(), retryAvailabilitySchema),
  leases: z.record(z.string(), accountLeaseSchema).default({}),
  updatedAt: z.string().datetime()
});

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

export async function updateSuccessfulAccount(
  filePath: string,
  accountName: string,
  accountIndex: number
): Promise<void> {
  const state = await loadStateFile(filePath);
  await saveStateFile(filePath, {
    ...state,
    currentIndex: accountIndex,
    lastSuccessfulAccount: accountName,
    updatedAt: new Date().toISOString()
  });
}

export async function markRetryAvailability(
  filePath: string,
  accountName: string,
  retryAvailability: RetryAvailability
): Promise<void> {
  const state = await loadStateFile(filePath);
  await saveStateFile(filePath, {
    ...state,
    retryAvailability: {
      ...state.retryAvailability,
      [accountName]: retryAvailability
    },
    updatedAt: new Date().toISOString()
  });
}

export async function saveAccountLease(filePath: string, lease: AccountLease): Promise<StateFile> {
  const state = await loadStateFile(filePath);
  const updated: StateFile = {
    ...state,
    leases: {
      ...state.leases,
      [lease.ownerId]: lease
    },
    updatedAt: lease.updatedAt
  };
  await saveStateFile(filePath, updated);
  return updated;
}

export async function removeAccountLease(filePath: string, ownerId: string): Promise<StateFile> {
  const state = await loadStateFile(filePath);
  const leases = { ...state.leases };
  delete leases[ownerId];
  const updated: StateFile = {
    ...state,
    leases,
    updatedAt: new Date().toISOString()
  };
  await saveStateFile(filePath, updated);
  return updated;
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
    retryAvailability: {},
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
    retryAvailability: result.data.retryAvailability,
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
