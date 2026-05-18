import { readFile } from 'node:fs/promises';
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

const accountsFileSchema = z.object({
  version: z.literal(1),
  preferred: z.string().trim().min(1).optional(),
  customQuotaPatterns: z.array(z.string()),
  accounts: z.array(accountSchema)
});

export type AccountInput = Omit<RelayAccount, 'addedAt'> & { addedAt?: string };

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

export async function addAccount(
  filePath: string,
  input: AccountInput,
  options: { overwrite?: boolean } = {}
): Promise<RelayAccount> {
  const account = validateAccount({
    ...input,
    addedAt: input.addedAt ?? new Date().toISOString()
  });
  const file = await loadAccountsFile(filePath);
  const existingIndex = file.accounts.findIndex((item) => item.name === account.name);

  if (existingIndex >= 0 && !options.overwrite) {
    throw new Error(`Account "${account.name}" already exists.`);
  }

  if (existingIndex >= 0) {
    file.accounts[existingIndex] = account;
  } else {
    file.accounts.push(account);
  }

  if (!file.preferred) {
    file.preferred = account.name;
  }

  await saveAccountsFile(filePath, file);
  return account;
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

export async function importAccountsFromFile(filePath: string): Promise<AccountInput[]> {
  return importAccountsFromText(await readFile(filePath, 'utf8'));
}

export function importAccountsFromText(raw: string): AccountInput[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonImport(trimmed);
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(parseTextImportLine);
}

function parseJsonImport(raw: string): AccountInput[] {
  const parsed = JSON.parse(raw) as unknown;
  const records = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && 'accounts' in parsed
      ? (parsed as { accounts: unknown }).accounts
      : [];

  if (!Array.isArray(records)) {
    throw new Error('Invalid import file: accounts must be an array.');
  }

  return records.map((record, index) => {
    const source = record as Partial<AccountInput> & {
      key?: string;
      baseURL?: string;
      url?: string;
    };
    const account: AccountInput = {
      name: source.name || inferName(source.baseUrl || '', index),
      apiKey: source.apiKey || source.key || '',
      baseUrl: source.baseUrl || source.baseURL || source.url || ''
    };
    if (source.model) {
      account.model = source.model;
    }
    return account;
  });
}

function parseTextImportLine(line: string, index: number): AccountInput {
  const parts = line.split(',').map((part) => part.trim());
  const [baseUrl = '', apiKey = '', name] = parts;

  return {
    name: name || inferName(baseUrl, index),
    apiKey,
    baseUrl
  };
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
    throw new Error(`Invalid account: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return normalizeAccount(result.data);
}

function validateAccountsFile(raw: unknown): AccountsFile {
  const result = accountsFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid accounts file: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
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

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
