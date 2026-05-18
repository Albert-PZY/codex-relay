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

export async function importKeyLinesFromFile(
  filePath: string,
  options: { baseUrl: string; namePrefix?: string }
): Promise<AccountInput[]> {
  return importKeyLinesWithBaseUrl(await readFile(filePath, 'utf8'), options);
}

export async function importSetupAccountsFromFile(
  filePath: string,
  options: { baseUrl?: string; namePrefix?: string }
): Promise<AccountInput[]> {
  return importSetupAccountsFromText(await readFile(filePath, 'utf8'), options);
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

export function importSetupAccountsFromText(
  raw: string,
  options: { baseUrl?: string; namePrefix?: string }
): AccountInput[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonImport(trimmed);
  }

  if (raw.split(/\r?\n/).some((line) => parseBaseUrlAssignment(line) || parseStandaloneBaseUrlLine(line.trim()))) {
    return parseSegmentedSetupText(raw, options);
  }

  if (options.baseUrl) {
    return importKeyLinesWithBaseUrl(raw, {
      baseUrl: options.baseUrl,
      ...(options.namePrefix ? { namePrefix: options.namePrefix } : {})
    });
  }

  if (firstEffectiveLine(raw)?.startsWith('http')) {
    return importAccountsFromText(raw);
  }

  throw new Error('No base URL found. Add a `base_url = "https://.../v1"` line or run with `--base-url <url>`.');
}

export function importKeyLinesWithBaseUrl(
  raw: string,
  options: { baseUrl: string; namePrefix?: string }
): AccountInput[] {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('Base URL must start with http:// or https://.');
  }
  const namePrefix = options.namePrefix?.trim() || inferName(baseUrl, 0);
  const keys = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isEffectiveDataLine);

  if (keys.length === 0) {
    throw new Error('No API keys found in the import file.');
  }

  return keys.map((apiKey, index) => ({
    name: `${namePrefix}-${index + 1}`,
    apiKey: requireNonEmptyKey(apiKey),
    baseUrl
  }));
}

function parseJsonImport(raw: string): AccountInput[] {
  const parsed = JSON.parse(raw) as unknown;
  const records = extractImportRecords(parsed);

  if (!Array.isArray(records)) {
    throw new Error('Invalid import file: accounts must be an array.');
  }

  return records.flatMap((record, index) => {
    const source = record as Partial<AccountInput> & {
      key?: string;
      baseURL?: string;
      url?: string;
      apiKeys?: string[];
      keys?: string[];
    };
    const baseUrl = source.baseUrl || source.baseURL || source.url || '';
    const keys = source.apiKeys || source.keys;
    if (Array.isArray(keys)) {
      if (!baseUrl) {
        throw new Error('Invalid import file: base URL is required for relay key pools.');
      }
      if (keys.length === 0) {
        throw new Error('Invalid import file: key pool must contain at least one API key.');
      }
      return keys.map((apiKey, keyIndex) => ({
        name: `${source.name || inferName(baseUrl, index)}-${keyIndex + 1}`,
        apiKey: requireNonEmptyKey(apiKey),
        baseUrl,
        ...(source.model ? { model: source.model } : {})
      }));
    }
    const account: AccountInput = {
      name: source.name || inferName(baseUrl, index),
      apiKey: source.apiKey || source.key || '',
      baseUrl
    };
    if (source.model) {
      account.model = source.model;
    }
    return [account];
  });
}

function parseTextImportLine(line: string, index: number): AccountInput {
  const parts = line.split(',').map((part) => part.trim());
  const [baseUrl = '', apiKey = '', name] = parts;
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('Invalid import line: base URL is required before the API key.');
  }
  if (!apiKey) {
    throw new Error('Invalid import line: API key is required after the base URL.');
  }

  return {
    name: name || inferName(baseUrl, index),
    apiKey,
    baseUrl
  };
}

function parseSegmentedSetupText(
  raw: string,
  options: { baseUrl?: string; namePrefix?: string }
): AccountInput[] {
  const groups: Array<{ baseUrl: string; keys: string[]; index: number }> = [];
  let current: { baseUrl: string; keys: string[]; index: number } | undefined;

  for (const line of raw.split(/\r?\n/).map((item) => item.trim())) {
    if (!isEffectiveDataLine(line)) {
      continue;
    }
    const assignedBaseUrl = parseBaseUrlAssignment(line);
    const inlineBaseUrl = parseStandaloneBaseUrlLine(line);
    if (assignedBaseUrl || inlineBaseUrl) {
      current = {
        baseUrl: assignedBaseUrl || inlineBaseUrl || '',
        keys: [],
        index: groups.length
      };
      groups.push(current);
      continue;
    }
    if (!current) {
      if (!options.baseUrl) {
        throw new Error('No base URL found before API key. Add a `base_url = "https://.../v1"` line first.');
      }
      current = {
        baseUrl: options.baseUrl,
        keys: [],
        index: groups.length
      };
      groups.push(current);
    }
    current.keys.push(requireNonEmptyKey(line));
  }

  if (groups.length === 0) {
    throw new Error('No relay accounts found in the setup file.');
  }

  let globalIndex = 0;
  const baseNameCounts = new Map<string, number>();
  const accounts = groups.flatMap((group) => {
    if (group.keys.length === 0) {
      throw new Error(`No API keys found after base URL ${group.baseUrl}.`);
    }
    return group.keys.map((apiKey) => {
      const baseCount = baseNameCounts.get(group.baseUrl) ?? 0;
      const name = options.namePrefix
        ? `${options.namePrefix}-${globalIndex + 1}`
        : `${inferName(group.baseUrl, group.index)}-${baseCount + 1}`;
      globalIndex += 1;
      baseNameCounts.set(group.baseUrl, baseCount + 1);
      return {
        name,
        apiKey,
        baseUrl: group.baseUrl
      };
    });
  });

  return accounts;
}

function parseBaseUrlAssignment(line: string): string | undefined {
  const match = line.match(/^(?:base_url|baseUrl|baseURL|url)\s*[:=]\s*["']?([^"'\s]+)["']?\s*$/i);
  const baseUrl = match?.[1]?.trim();
  if (!baseUrl) {
    return undefined;
  }
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('Base URL must start with http:// or https://.');
  }
  return baseUrl;
}

function parseStandaloneBaseUrlLine(line: string): string | undefined {
  if (!line.startsWith('http://') && !line.startsWith('https://')) {
    return undefined;
  }
  if (line.includes(',')) {
    return undefined;
  }
  return line;
}

function firstEffectiveLine(raw: string): string | undefined {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(isEffectiveDataLine);
}

function isEffectiveDataLine(line: string): boolean {
  return Boolean(line) && !line.startsWith('#') && !isSeparatorLine(line);
}

function isSeparatorLine(line: string): boolean {
  return /^[-_=*—–]+$/.test(line.trim());
}

function extractImportRecords(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const object = parsed as {
    accounts?: unknown;
    relays?: unknown;
    pools?: unknown;
  };
  for (const field of [object.accounts, object.relays, object.pools]) {
    if (Array.isArray(field)) {
      return field;
    }
  }
  return [];
}

function inferName(baseUrl: string, index: number): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/[^a-zA-Z0-9-]+/g, '-');
    return host || `relay-${index + 1}`;
  } catch {
    return `relay-${index + 1}`;
  }
}

function requireNonEmptyKey(apiKey: string): string {
  if (!apiKey?.trim()) {
    throw new Error('Invalid import file: API key cannot be empty.');
  }
  return apiKey;
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
