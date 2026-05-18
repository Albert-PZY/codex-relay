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
}

export interface RunnerOptions {
  accountName?: string;
  prompt?: string;
  codexArgs: string[];
  cwd?: string;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  usedAccount?: string;
}
