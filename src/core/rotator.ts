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

export function getAccountByName(accountsFile: AccountsFile, name: string): RelayAccount | undefined {
  return accountsFile.accounts.find((account) => account.name === name);
}

export function getAccountIndex(accountsFile: AccountsFile, name: string): number {
  return accountsFile.accounts.findIndex((account) => account.name === name);
}

export function isAccountAvailable(name: string, now = new Date(), health?: HealthFile): boolean {
  return health ? isAccountHealthy(name, health, now) : true;
}

export function isRelayAccountAvailable(account: RelayAccount, now = new Date(), health?: HealthFile): boolean {
  return health ? isAccountHealthy(account, health, now) : true;
}
