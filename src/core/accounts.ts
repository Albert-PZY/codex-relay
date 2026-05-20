import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../utils/atomic.js';
import type { AccountsFile, RelayAccount } from '../types.js';

const accountSchema = z.object({
  name: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1).optional(),
  addedAt: z.string().datetime()
});

const importAccountSchema = z.object({
  name: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1).optional()
}).strict();

const accountsFileSchema = z.object({
  version: z.literal(1),
  preferred: z.string().trim().min(1).optional(),
  customQuotaPatterns: z.array(z.string()),
  accounts: z.array(accountSchema)
});

export type AccountInput = Omit<RelayAccount, 'addedAt'> & { addedAt?: string };
export interface ImportedAccountInput {
  apiKey: string;
  baseUrl: string;
  name?: string | undefined;
  model?: string | undefined;
}

export async function loadAccountsFile(filePath: string): Promise<AccountsFile> {
  try {
    const parsed = await readJsonFile<unknown>(filePath);
    return validateAccountsFile(parsed);
  } catch (error) {
    if (isMissingFile(error)) {
      return createEmptyAccountsFile();
    }
    throw error;
  }
}

export async function saveAccountsFile(filePath: string, data: AccountsFile): Promise<void> {
  await writeJsonAtomic(filePath, validateAccountsFile(repairPreferred(data)));
}

export async function listAccounts(filePath: string): Promise<RelayAccount[]> {
  return (await loadAccountsFile(filePath)).accounts;
}

export async function addAccounts(
  filePath: string,
  inputs: AccountInput[],
  options: { overwrite?: boolean } = {}
): Promise<RelayAccount[]> {
  if (inputs.length === 0) {
    return [];
  }

  const addedAt = new Date().toISOString();
  const accounts = inputs.map((input) =>
    validateAccount({
      ...input,
      addedAt: input.addedAt ?? addedAt
    })
  );
  const batchNames = new Set<string>();
  for (const account of accounts) {
    if (batchNames.has(account.name)) {
      throw new Error(`Account "${account.name}" already exists in the import batch.`);
    }
    batchNames.add(account.name);
  }

  const file = await loadAccountsFile(filePath);
  const nextAccounts = [...file.accounts];
  const existingIndexes = new Map<string, number>();

  nextAccounts.forEach((account, index) => {
    existingIndexes.set(account.name, index);
  });

  for (const account of accounts) {
    const existingIndex = existingIndexes.get(account.name);
    if (existingIndex !== undefined) {
      if (!options.overwrite) {
        throw new Error(`Account "${account.name}" already exists.`);
      }
      nextAccounts[existingIndex] = account;
      continue;
    }

    existingIndexes.set(account.name, nextAccounts.length);
    nextAccounts.push(account);
  }

  await saveAccountsFile(filePath, {
    ...file,
    ...(file.preferred ? {} : { preferred: accounts[0]!.name }),
    accounts: nextAccounts
  });
  return accounts;
}

export async function mergeImportedAccounts(
  filePath: string,
  inputs: ImportedAccountInput[]
): Promise<RelayAccount[]> {
  if (inputs.length === 0) {
    return [];
  }

  const addedAt = new Date().toISOString();
  const candidates = inputs.map((input, index) => validateImportedAccount(input, index));
  const file = await loadAccountsFile(filePath);
  const seenNames = new Set(file.accounts.map((account) => account.name));
  const seenFingerprints = new Set(file.accounts.map((account) => accountFingerprint(account)));
  const generatedNameCounters = seedGeneratedNameCounters([...seenNames]);
  const imported: RelayAccount[] = [];

  for (const candidate of candidates) {
    const fingerprint = accountFingerprint(candidate);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }

    const name = candidate.name ?? generateAccountName(candidate.baseUrl, seenNames, generatedNameCounters);
    if (seenNames.has(name)) {
      continue;
    }

    const account = validateAccount({
      ...candidate,
      name,
      addedAt
    });

    seenNames.add(account.name);
    seenFingerprints.add(fingerprint);
    imported.push(account);
  }

  if (imported.length === 0) {
    return [];
  }

  await saveAccountsFile(filePath, {
    ...file,
    ...(file.preferred ? {} : { preferred: imported[0]!.name }),
    accounts: [...file.accounts, ...imported]
  });
  return imported;
}

export async function addAccount(
  filePath: string,
  input: AccountInput,
  options: { overwrite?: boolean } = {}
): Promise<RelayAccount> {
  const [account] = await addAccounts(filePath, [input], options);
  return account!;
}

export async function removeAccount(filePath: string, name: string): Promise<void> {
  const file = await loadAccountsFile(filePath);
  const nextAccounts = file.accounts.filter((account) => account.name !== name);

  if (nextAccounts.length === file.accounts.length) {
    throw new Error(`Account "${name}" does not exist.`);
  }

  await saveAccountsFile(filePath, {
    ...file,
    accounts: nextAccounts
  });
}

export async function setPreferredAccount(filePath: string, name: string): Promise<void> {
  const file = await loadAccountsFile(filePath);
  if (!file.accounts.some((account) => account.name === name)) {
    throw new Error(`Account "${name}" does not exist.`);
  }

  await saveAccountsFile(filePath, {
    ...file,
    preferred: name
  });
}

export async function importAccountsFromFile(filePath: string): Promise<ImportedAccountInput[]> {
  try {
    return parseImportedAccounts(await readJsonFile<unknown>(filePath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Import file must be valid JSON.');
    }
    throw error;
  }
}

function parseImportedAccounts(raw: unknown): ImportedAccountInput[] {
  if (!Array.isArray(raw)) {
    throw new Error('Import file must be a top-level array of account objects.');
  }

  return raw.map((record, index) => validateImportedAccount(record, index));
}

function validateImportedAccount(raw: unknown, index: number): ImportedAccountInput {
  const result = importAccountSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid import file at item ${index + 1}: ${formatZodIssues(result.error.issues)}`);
  }
  return result.data;
}

function seedGeneratedNameCounters(names: string[]): Map<string, number> {
  const counters = new Map<string, number>();
  for (const name of names) {
    const match = name.match(/^(.*)-(\d+)$/);
    if (!match) {
      continue;
    }
    const baseName = match[1]!;
    const suffix = Number.parseInt(match[2]!, 10);
    counters.set(baseName, Math.max(counters.get(baseName) ?? 0, suffix));
  }
  return counters;
}

function generateAccountName(
  baseUrl: string,
  seenNames: Set<string>,
  counters: Map<string, number>
): string {
  const baseName = inferName(baseUrl, 0);
  let suffix = (counters.get(baseName) ?? 0) + 1;
  let candidate = `${baseName}-${suffix}`;
  while (seenNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}-${suffix}`;
  }
  counters.set(baseName, suffix);
  return candidate;
}

function inferName(baseUrl: string, index: number): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/[^a-zA-Z0-9-]+/g, '-');
    return host || `relay-${index + 1}`;
  } catch {
    return `relay-${index + 1}`;
  }
}

function validateAccount(raw: unknown): RelayAccount {
  const result = accountSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid account: ${formatZodIssues(result.error.issues)}`);
  }
  return normalizeAccount(result.data);
}

function validateAccountsFile(raw: unknown): AccountsFile {
  const result = accountsFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid accounts file: ${formatZodIssues(result.error.issues)}`);
  }
  const normalizedAccounts = result.data.accounts.map(normalizeAccount);
  const names = new Set<string>();
  for (const account of normalizedAccounts) {
    if (names.has(account.name)) {
      throw new Error(`Invalid accounts file: duplicate account "${account.name}".`);
    }
    names.add(account.name);
  }
  return repairPreferred({
    version: 1,
    ...(result.data.preferred ? { preferred: result.data.preferred } : {}),
    customQuotaPatterns: result.data.customQuotaPatterns,
    accounts: normalizedAccounts
  });
}

function repairPreferred(file: AccountsFile): AccountsFile {
  const preferred = file.preferred && file.accounts.some((account) => account.name === file.preferred)
    ? file.preferred
    : file.accounts[0]?.name;

  const repaired: AccountsFile = {
    version: file.version,
    customQuotaPatterns: [...file.customQuotaPatterns],
    accounts: file.accounts.map(normalizeAccount)
  };
  if (preferred) {
    repaired.preferred = preferred;
  } else {
    delete repaired.preferred;
  }
  return repaired;
}

function createEmptyAccountsFile(): AccountsFile {
  return {
    version: 1,
    customQuotaPatterns: [],
    accounts: []
  };
}

type ParsedAccount = z.infer<typeof accountSchema>;

function normalizeAccount(account: ParsedAccount): RelayAccount {
  const normalized: RelayAccount = {
    name: account.name,
    apiKey: account.apiKey,
    baseUrl: account.baseUrl,
    addedAt: account.addedAt
  };
  if (account.model) {
    normalized.model = account.model;
  }
  return normalized;
}

function accountFingerprint(account: { apiKey: string; baseUrl: string; model?: string | undefined }): string {
  return [account.baseUrl, account.apiKey, account.model ?? ''].join('\u0001');
}

function formatZodIssues(issues: Array<{ path: readonly PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
