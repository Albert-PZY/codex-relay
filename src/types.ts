export interface RelayAccount {
  name: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  addedAt: string;
}

export interface AccountsFile {
  version: 1;
  preferred?: string;
  customQuotaPatterns: string[];
  accounts: RelayAccount[];
}

export interface RetryAvailability {
  displayText: string;
  availableAt: string;
}

export type HealthFailureReason = 'auth' | 'quota' | 'rate_limit' | 'server' | 'unknown';

export interface AccountHealth {
  status: 'active' | 'cooldown';
  baseUrl?: string;
  reason?: HealthFailureReason;
  firstFailedAt?: string;
  lastFailedAt?: string;
  lastSuccessAt?: string;
  cooldownUntil?: string;
  consecutiveFailures: number;
}

export interface RetiredAccountHealth {
  name: string;
  baseUrl?: string;
  reason: HealthFailureReason;
  firstFailedAt: string;
  lastFailedAt: string;
  removedAt: string;
}

export interface HealthFile {
  version: 1;
  accounts: Record<string, AccountHealth>;
  retired: RetiredAccountHealth[];
  updatedAt: string;
}

export interface StateFile {
  version: 1;
  currentIndex: number;
  lastSuccessfulAccount?: string;
  retryAvailability: Record<string, RetryAvailability>;
  updatedAt: string;
}

export interface DetectorMatch {
  confidence: 'high' | 'medium' | 'none';
  matchedText?: string;
  retryAfterMs?: number;
  reason?: HealthFailureReason;
}

export interface RunnerOptions {
  accountName?: string;
  codexArgs: string[];
  cwd?: string;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  usedAccount?: string;
}
