import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic.js';
import type {
  AccountHealth,
  AccountsFile,
  HealthFailureReason,
  HealthFile,
  RelayAccount,
  RetiredAccountHealth
} from '../types.js';

const RETIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const COOLDOWN_MS: Record<HealthFailureReason, number> = {
  auth: RETIRE_AFTER_MS,
  quota: 12 * 60 * 60 * 1000,
  rate_limit: 5 * 60 * 1000,
  server: 60 * 1000,
  unknown: 60 * 1000
};

const accountHealthSchema = z.object({
  status: z.enum(['active', 'cooldown']),
  baseUrl: z.string().url().optional(),
  reason: z.enum(['auth', 'quota', 'rate_limit', 'server', 'unknown']).optional(),
  firstFailedAt: z.string().datetime().optional(),
  lastFailedAt: z.string().datetime().optional(),
  lastSuccessAt: z.string().datetime().optional(),
  cooldownUntil: z.string().datetime().optional(),
  consecutiveFailures: z.number().int().min(0)
});

const retiredAccountSchema = z.object({
  name: z.string().trim().min(1),
  baseUrl: z.string().url().optional(),
  reason: z.enum(['auth', 'quota', 'rate_limit', 'server', 'unknown']),
  firstFailedAt: z.string().datetime(),
  lastFailedAt: z.string().datetime(),
  removedAt: z.string().datetime()
});

const healthFileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), accountHealthSchema),
  retired: z.array(retiredAccountSchema),
  updatedAt: z.string().datetime()
});

export async function loadHealthFile(filePath: string): Promise<HealthFile> {
  try {
    const parsed = await readJsonFile<unknown>(filePath);
    return validateHealthFile(parsed);
  } catch (error) {
    if (isMissingFile(error)) {
      return createDefaultHealth();
    }
    throw error;
  }
}

export async function saveHealthFile(filePath: string, health: HealthFile): Promise<void> {
  await writeJsonAtomic(filePath, validateHealthFile({
    ...health,
    updatedAt: health.updatedAt || new Date().toISOString()
  }));
}

export async function recordAccountFailure(
  filePath: string,
  input: {
    accountName: string;
    baseUrl?: string;
    reason: HealthFailureReason;
    now: Date;
    retryAfterMs?: number;
  }
): Promise<HealthFile> {
  const health = await loadHealthFile(filePath);
  const nowIso = input.now.toISOString();
  const current = health.accounts[input.accountName];
  const cooldownMs = input.retryAfterMs ?? COOLDOWN_MS[input.reason];
  const next: AccountHealth = {
    status: 'cooldown',
    consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
    reason: input.reason,
    firstFailedAt: current?.firstFailedAt ?? nowIso,
    lastFailedAt: nowIso,
    cooldownUntil: new Date(input.now.getTime() + cooldownMs).toISOString()
  };
  if (input.baseUrl) {
    next.baseUrl = input.baseUrl;
  } else if (current?.baseUrl) {
    next.baseUrl = current.baseUrl;
  }
  if (current?.lastSuccessAt) {
    next.lastSuccessAt = current.lastSuccessAt;
  }

  const updated: HealthFile = {
    ...health,
    accounts: {
      ...health.accounts,
      [input.accountName]: next
    },
    updatedAt: nowIso
  };
  await saveHealthFile(filePath, updated);
  return updated;
}

export async function recordAccountSuccess(filePath: string, accountName: string, now: Date): Promise<HealthFile> {
  const health = await loadHealthFile(filePath);
  const current = health.accounts[accountName];
  const next: AccountHealth = {
    status: 'active',
    consecutiveFailures: 0,
    lastSuccessAt: now.toISOString()
  };
  if (current?.baseUrl) {
    next.baseUrl = current.baseUrl;
  }

  const updated: HealthFile = {
    ...health,
    accounts: {
      ...health.accounts,
      [accountName]: next
    },
    updatedAt: now.toISOString()
  };
  await saveHealthFile(filePath, updated);
  return updated;
}

export function isAccountHealthy(accountName: string, health: HealthFile, now = new Date()): boolean {
  const entry = health.accounts[accountName];
  if (!entry?.cooldownUntil) {
    return true;
  }
  return new Date(entry.cooldownUntil).getTime() <= now.getTime();
}

export async function retireExpiredHealthAccounts(
  filePath: string,
  accountsFile: AccountsFile,
  now: Date
): Promise<{ accountsFile: AccountsFile; health: HealthFile; retiredNames: string[] }> {
  const health = await loadHealthFile(filePath);
  const expiredNames = new Set<string>();

  for (const [name, entry] of Object.entries(health.accounts)) {
    if (!entry.firstFailedAt || entry.status !== 'cooldown') {
      continue;
    }
    const failedForMs = now.getTime() - new Date(entry.firstFailedAt).getTime();
    if (failedForMs >= RETIRE_AFTER_MS) {
      expiredNames.add(name);
    }
  }

  if (expiredNames.size === 0) {
    return { accountsFile, health, retiredNames: [] };
  }

  const removedAccounts = accountsFile.accounts.filter((account) => expiredNames.has(account.name));
  const nextAccounts = accountsFile.accounts.filter((account) => !expiredNames.has(account.name));
  const nextHealthAccounts = { ...health.accounts };
  for (const name of expiredNames) {
    delete nextHealthAccounts[name];
  }

  const updatedHealth: HealthFile = {
    ...health,
    accounts: nextHealthAccounts,
    retired: [
      ...health.retired,
      ...removedAccounts.map((account) => toRetiredAccount(account, health.accounts[account.name]!, now))
    ],
    updatedAt: now.toISOString()
  };

  const nextAccountsFile: AccountsFile = {
    version: accountsFile.version,
    customQuotaPatterns: [...accountsFile.customQuotaPatterns],
    accounts: nextAccounts
  };
  const preferred = accountsFile.preferred && nextAccounts.some((account) => account.name === accountsFile.preferred)
    ? accountsFile.preferred
    : nextAccounts[0]?.name;
  if (preferred) {
    nextAccountsFile.preferred = preferred;
  }

  await saveHealthFile(filePath, updatedHealth);
  return {
    accountsFile: nextAccountsFile,
    health: updatedHealth,
    retiredNames: [...expiredNames]
  };
}

function toRetiredAccount(account: RelayAccount, health: AccountHealth, now: Date) {
  return {
    name: account.name,
    baseUrl: health.baseUrl ?? account.baseUrl,
    reason: health.reason ?? 'unknown',
    firstFailedAt: health.firstFailedAt ?? now.toISOString(),
    lastFailedAt: health.lastFailedAt ?? health.firstFailedAt ?? now.toISOString(),
    removedAt: now.toISOString()
  };
}

function createDefaultHealth(): HealthFile {
  return {
    version: 1,
    accounts: {},
    retired: [],
    updatedAt: new Date().toISOString()
  };
}

function validateHealthFile(raw: unknown): HealthFile {
  const result = healthFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid health file: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return {
    version: 1,
    accounts: Object.fromEntries(
      Object.entries(result.data.accounts).map(([name, entry]) => [name, normalizeAccountHealth(entry)])
    ),
    retired: result.data.retired.map(normalizeRetiredAccountHealth),
    updatedAt: result.data.updatedAt
  };
}

type ParsedAccountHealth = z.infer<typeof accountHealthSchema>;
type ParsedRetiredAccountHealth = z.infer<typeof retiredAccountSchema>;

function normalizeAccountHealth(entry: ParsedAccountHealth): AccountHealth {
  const normalized: AccountHealth = {
    status: entry.status,
    consecutiveFailures: entry.consecutiveFailures
  };
  if (entry.baseUrl) {
    normalized.baseUrl = entry.baseUrl;
  }
  if (entry.reason) {
    normalized.reason = entry.reason;
  }
  if (entry.firstFailedAt) {
    normalized.firstFailedAt = entry.firstFailedAt;
  }
  if (entry.lastFailedAt) {
    normalized.lastFailedAt = entry.lastFailedAt;
  }
  if (entry.lastSuccessAt) {
    normalized.lastSuccessAt = entry.lastSuccessAt;
  }
  if (entry.cooldownUntil) {
    normalized.cooldownUntil = entry.cooldownUntil;
  }
  return normalized;
}

function normalizeRetiredAccountHealth(entry: ParsedRetiredAccountHealth): RetiredAccountHealth {
  const normalized: RetiredAccountHealth = {
    name: entry.name,
    reason: entry.reason,
    firstFailedAt: entry.firstFailedAt,
    lastFailedAt: entry.lastFailedAt,
    removedAt: entry.removedAt
  };
  if (entry.baseUrl) {
    normalized.baseUrl = entry.baseUrl;
  }
  return normalized;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
