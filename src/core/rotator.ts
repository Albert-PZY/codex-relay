import { isAccountHealthy } from './health.js';
import type { AccountsFile, HealthFile, RelayAccount, StateFile } from '../types.js';

export function buildRotationOrder(
  accountsFile: AccountsFile,
  state: StateFile,
  requestedAccount?: string
): string[] {
  const accounts = accountsFile.accounts.map((account) => account.name);
  if (accounts.length === 0) {
    return [];
  }

  const startName = requestedAccount || accountsFile.preferred || accounts[state.currentIndex] || accounts[0];
  const startIndex = Math.max(0, accounts.indexOf(startName || accounts[0]!));

  return [...accounts.slice(startIndex), ...accounts.slice(0, startIndex)];
}

export function chooseNextAccount(
  accountsFile: AccountsFile,
  state: StateFile,
  currentAccount?: string,
  now = new Date(),
  requestedAccount?: string,
  health?: HealthFile
): string | undefined {
  const order = buildRotationOrder(accountsFile, state, requestedAccount);
  if (order.length === 0) {
    return undefined;
  }

  if (currentAccount && isAccountAvailable(currentAccount, state, now, health)) {
    return currentAccount;
  }

  const startIndex = currentAccount ? order.indexOf(currentAccount) : -1;
  const candidates = startIndex >= 0
    ? [...order.slice(startIndex + 1), ...order.slice(0, startIndex + 1)]
    : order;

  return candidates.find((name) => isAccountAvailable(name, state, now, health));
}

export function getAccountByName(accountsFile: AccountsFile, name: string): RelayAccount | undefined {
  return accountsFile.accounts.find((account) => account.name === name);
}

export function getAccountIndex(accountsFile: AccountsFile, name: string): number {
  return accountsFile.accounts.findIndex((account) => account.name === name);
}

export function isAccountAvailable(name: string, state: StateFile, now = new Date(), health?: HealthFile): boolean {
  const retry = state.retryAvailability[name];
  if (retry && new Date(retry.availableAt).getTime() > now.getTime()) {
    return false;
  }
  return health ? isAccountHealthy(name, health, now) : true;
}
