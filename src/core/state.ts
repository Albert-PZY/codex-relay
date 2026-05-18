import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic.js';
import type { RetryAvailability, StateFile } from '../types.js';

const retryAvailabilitySchema = z.object({
  displayText: z.string().trim().min(1),
  availableAt: z.string().datetime()
});

const stateFileSchema = z.object({
  version: z.literal(1),
  currentIndex: z.number().int().min(0),
  lastSuccessfulAccount: z.string().trim().min(1).optional(),
  retryAvailability: z.record(z.string(), retryAvailabilitySchema),
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

export function createDefaultState(): StateFile {
  return {
    version: 1,
    currentIndex: 0,
    retryAvailability: {},
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
    updatedAt: result.data.updatedAt
  };
  if (result.data.lastSuccessfulAccount) {
    state.lastSuccessfulAccount = result.data.lastSuccessfulAccount;
  }
  return state;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
