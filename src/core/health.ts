import { createHash } from 'node:crypto';
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

const COOLDOWN_MS = 30 * 60 * 1000;
const RETIRE_AFTER_COOLDOWNS = 10;

const accountHealthSchema = z.object({
  status: z.enum(['active', 'cooldown']),
  baseUrl: z.string().url().optional(),
  credentialHash: z.string().trim().min(1).optional(),
  reason: z.enum(['auth', 'quota', 'rate_limit', 'server', 'unknown']).optional(),
  firstFailedAt: z.string().datetime().optional(),
  lastFailedAt: z.string().datetime().optional(),
  lastSuccessAt: z.string().datetime().optional(),
  cooldownUntil: z.string().datetime().optional(),
  consecutiveFailures: z.number().int().min(0),
  cooldownCount: z.number().int().min(0).optional()
}).strict();

const retiredAccountSchema = z.object({
  name: z.string().trim().min(1),
  baseUrl: z.string().url().optional(),
  credentialHash: z.string().trim().min(1).optional(),
  reason: z.enum(['auth', 'quota', 'rate_limit', 'server', 'unknown']),
  firstFailedAt: z.string().datetime(),
  lastFailedAt: z.string().datetime(),
  removedAt: z.string().datetime(),
  cooldownCount: z.number().int().min(0).optional()
}).strict();

const healthFileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), accountHealthSchema),
  retired: z.array(retiredAccountSchema),
  updatedAt: z.string().datetime()
}).strict();

type AccountHealthRef = Pick<RelayAccount, 'name' | 'apiKey' | 'baseUrl'>;

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
    apiKey?: string;
    baseUrl?: string;
    reason: HealthFailureReason;
    now: Date;
    retryAfterMs?: number;
  }
): Promise<HealthFile> {
  const health = await loadHealthFile(filePath);
  const nowIso = input.now.toISOString();
  const credentialHash = resolveCredentialHash(input);
  const current = findAccountHealth(input.accountName, credentialHash, health);
  const next: AccountHealth = {
    status: 'cooldown',
    consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
    cooldownCount: (current?.cooldownCount ?? 0) + 1,
    reason: input.reason,
    firstFailedAt: current?.firstFailedAt ?? nowIso,
    lastFailedAt: nowIso,
    cooldownUntil: new Date(input.now.getTime() + COOLDOWN_MS).toISOString()
  };
  if (input.baseUrl) {
    next.baseUrl = input.baseUrl;
  } else if (current?.baseUrl) {
    next.baseUrl = current.baseUrl;
  }
  if (credentialHash) {
    next.credentialHash = credentialHash;
  } else if (current?.credentialHash) {
    next.credentialHash = current.credentialHash;
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

export async function recordAccountSuccess(
  filePath: string,
  account: string | AccountHealthRef,
  now: Date
): Promise<HealthFile> {
  const health = await loadHealthFile(filePath);
  const identity = normalizeAccountIdentity(account);
  const current = findAccountHealth(identity.name, identity.credentialHash, health);
  const next = buildActiveHealth(current, identity, now);
  const accounts = updateMatchingHealthEntries(health.accounts, identity, next);

  const updated: HealthFile = {
    ...health,
    accounts,
    updatedAt: now.toISOString()
  };
  await saveHealthFile(filePath, updated);
  return updated;
}

export async function resetAccountCooldown(
  filePath: string,
  account: AccountHealthRef,
  now = new Date()
): Promise<HealthFile> {
  const health = await loadHealthFile(filePath);
  const identity = normalizeAccountIdentity(account);
  const current = findAccountHealth(identity.name, identity.credentialHash, health);
  const next = buildActiveHealth(current, identity, now);
  const updated: HealthFile = {
    ...health,
    accounts: updateMatchingHealthEntries(health.accounts, identity, next),
    updatedAt: now.toISOString()
  };
  await saveHealthFile(filePath, updated);
  return updated;
}

export async function resetAllAccountCooldowns(
  filePath: string,
  accountsToReset: AccountHealthRef[],
  now = new Date()
): Promise<HealthFile> {
  const health = await loadHealthFile(filePath);
  let accounts = { ...health.accounts };
  for (const account of accountsToReset) {
    const identity = normalizeAccountIdentity(account);
    const current = findAccountHealth(identity.name, identity.credentialHash, { ...health, accounts });
    accounts = updateMatchingHealthEntries(accounts, identity, buildActiveHealth(current, identity, now));
  }

  const updated: HealthFile = {
    ...health,
    accounts,
    updatedAt: now.toISOString()
  };
  await saveHealthFile(filePath, updated);
  return updated;
}

export function getAccountHealth(
  account: string | AccountHealthRef,
  health: HealthFile,
  now = new Date()
): AccountHealth | undefined {
  const identity = normalizeAccountIdentity(account);
  return getAccountHealthByIdentity(identity, health, now);
}

export function isAccountHealthy(account: string | AccountHealthRef, health: HealthFile, now = new Date()): boolean {
  const entry = getAccountHealth(account, health, now);
  if (!entry || entry.status === 'active') {
    return true;
  }
  if (!entry.cooldownUntil) {
    return false;
  }
  return new Date(entry.cooldownUntil).getTime() <= now.getTime();
}

export async function retireExpiredHealthAccounts(
  filePath: string,
  accountsFile: AccountsFile,
  now: Date
): Promise<{ accountsFile: AccountsFile; health: HealthFile; retiredNames: string[] }> {
  const health = await loadHealthFile(filePath);
  const retiredNames = new Set<string>();

  for (const account of accountsFile.accounts) {
    const entry = getAccountHealth(account, health, now);
    if (entry && entry.status === 'cooldown' && (entry.cooldownCount ?? 0) >= RETIRE_AFTER_COOLDOWNS) {
      retiredNames.add(account.name);
    }
  }

  if (retiredNames.size === 0) {
    return { accountsFile, health, retiredNames: [] };
  }

  const removedAccounts = accountsFile.accounts.filter((account) => retiredNames.has(account.name));
  const retiredCredentialHashes = new Set(
    removedAccounts.map((account) => accountCredentialHash(account))
  );
  const nextAccounts = accountsFile.accounts.filter((account) => !retiredNames.has(account.name));
  const nextHealthAccounts = Object.fromEntries(
    Object.entries(health.accounts).filter(([name, entry]) =>
      !retiredNames.has(name) &&
      (!entry.credentialHash || !retiredCredentialHashes.has(entry.credentialHash))
    )
  );

  const updatedHealth: HealthFile = {
    ...health,
    accounts: nextHealthAccounts,
    retired: [
      ...health.retired,
      ...removedAccounts.map((account) =>
        toRetiredAccount(account, getAccountHealth(account, health, now), now)
      )
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
    retiredNames: [...retiredNames]
  };
}

export function accountCredentialHash(account: Pick<RelayAccount, 'apiKey' | 'baseUrl'>): string {
  return createHash('sha256')
    .update(normalizeBaseUrl(account.baseUrl))
    .update('\0')
    .update(account.apiKey.trim())
    .digest('hex');
}

function buildActiveHealth(
  current: AccountHealth | undefined,
  identity: AccountIdentity,
  now: Date
): AccountHealth {
  const next: AccountHealth = {
    status: 'active',
    consecutiveFailures: 0,
    cooldownCount: 0
  };
  const baseUrl = identity.baseUrl ?? current?.baseUrl;
  const credentialHash = identity.credentialHash ?? current?.credentialHash;
  if (baseUrl) {
    next.baseUrl = baseUrl;
  }
  if (credentialHash) {
    next.credentialHash = credentialHash;
  }
  next.lastSuccessAt = now.toISOString();
  return next;
}

function updateMatchingHealthEntries(
  accounts: HealthFile['accounts'],
  identity: AccountIdentity,
  next: AccountHealth
): HealthFile['accounts'] {
  const updated = { ...accounts };
  for (const [name, entry] of Object.entries(updated)) {
    if (name === identity.name || entryMatchesIdentity(entry, identity)) {
      updated[name] = {
        ...next,
        ...(entry.baseUrl && !next.baseUrl ? { baseUrl: entry.baseUrl } : {})
      };
    }
  }
  updated[identity.name] = next;
  return updated;
}

function findAccountHealth(
  accountName: string,
  credentialHash: string | undefined,
  health: HealthFile
): AccountHealth | undefined {
  const identity: AccountIdentity = { name: accountName };
  if (credentialHash) {
    identity.credentialHash = credentialHash;
  }
  return getAccountHealthByIdentity(identity, health);
}

function getAccountHealthByIdentity(
  identity: AccountIdentity,
  health: HealthFile,
  now = new Date()
): AccountHealth | undefined {
  const direct = health.accounts[identity.name];
  const candidates = Object.values(health.accounts).filter((entry) =>
    entryMatchesIdentity(entry, identity)
  );
  if (direct && !candidates.includes(direct)) {
    candidates.push(direct);
  }
  if (candidates.length === 0) {
    return undefined;
  }

  return selectMostRelevantHealth(candidates, now);
}

function selectMostRelevantHealth(candidates: AccountHealth[], now: Date): AccountHealth {
  const cooling = candidates
    .filter((entry) => entry.cooldownUntil && new Date(entry.cooldownUntil).getTime() > now.getTime())
    .sort(compareHealthByCooldown);
  if (cooling[0]) {
    return cooling[0];
  }
  return [...candidates].sort(compareHealthByUpdatedAt)[0]!;
}

function compareHealthByCooldown(left: AccountHealth, right: AccountHealth): number {
  return dateMs(right.cooldownUntil) - dateMs(left.cooldownUntil);
}

function compareHealthByUpdatedAt(left: AccountHealth, right: AccountHealth): number {
  return latestHealthMs(right) - latestHealthMs(left);
}

function latestHealthMs(entry: AccountHealth): number {
  return Math.max(
    dateMs(entry.lastFailedAt),
    dateMs(entry.lastSuccessAt),
    dateMs(entry.cooldownUntil),
    dateMs(entry.firstFailedAt)
  );
}

function dateMs(value: string | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

function toRetiredAccount(account: RelayAccount, health: AccountHealth | undefined, now: Date): RetiredAccountHealth {
  const retired: RetiredAccountHealth = {
    name: account.name,
    reason: health?.reason ?? 'unknown',
    firstFailedAt: health?.firstFailedAt ?? now.toISOString(),
    lastFailedAt: health?.lastFailedAt ?? health?.firstFailedAt ?? now.toISOString(),
    removedAt: now.toISOString()
  };
  retired.baseUrl = health?.baseUrl ?? account.baseUrl;
  retired.credentialHash = health?.credentialHash ?? accountCredentialHash(account);
  retired.cooldownCount = health?.cooldownCount ?? 0;
  return retired;
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
    consecutiveFailures: entry.consecutiveFailures,
    cooldownCount: entry.cooldownCount ?? entry.consecutiveFailures
  };
  if (entry.baseUrl) {
    normalized.baseUrl = entry.baseUrl;
  }
  if (entry.credentialHash) {
    normalized.credentialHash = entry.credentialHash;
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
  if (entry.credentialHash) {
    normalized.credentialHash = entry.credentialHash;
  }
  if (entry.cooldownCount !== undefined) {
    normalized.cooldownCount = entry.cooldownCount;
  }
  return normalized;
}

interface AccountIdentity {
  name: string;
  baseUrl?: string;
  credentialHash?: string;
}

function normalizeAccountIdentity(account: string | AccountHealthRef | AccountIdentity): AccountIdentity {
  if (typeof account === 'string') {
    return { name: account };
  }
  const identity: AccountIdentity = {
    name: account.name
  };
  if ('baseUrl' in account && account.baseUrl) {
    identity.baseUrl = account.baseUrl;
  }
  if ('credentialHash' in account && account.credentialHash) {
    identity.credentialHash = account.credentialHash;
  } else if ('apiKey' in account && account.apiKey && 'baseUrl' in account && account.baseUrl) {
    identity.credentialHash = accountCredentialHash(account);
  }
  return identity;
}

function entryMatchesIdentity(entry: AccountHealth, identity: AccountIdentity): boolean {
  return Boolean(identity.credentialHash && entry.credentialHash === identity.credentialHash);
}

function resolveCredentialHash(input: { apiKey?: string; baseUrl?: string }): string | undefined {
  return input.apiKey && input.baseUrl
    ? accountCredentialHash({ apiKey: input.apiKey, baseUrl: input.baseUrl })
    : undefined;
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/+$/, '');
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
