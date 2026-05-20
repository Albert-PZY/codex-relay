import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadAccountsFile, saveAccountsFile } from './accounts.js';
import { detectOutput, extractSessionId } from './detector.js';
import {
  loadHealthFile,
  recordAccountFailure,
  recordAccountSuccess,
  retireExpiredHealthAccounts
} from './health.js';
import {
  loadStateFile,
  markRetryAvailability,
  pruneExpiredLeases,
  removeAccountLease,
  saveStateFile,
  updateSuccessfulAccount
} from './state.js';
import { buildRotationOrder, getAccountByName, getAccountIndex, isAccountAvailable } from './rotator.js';
import { withStoreLock } from './store-lock.js';
import { resolveDataPaths, type DataPaths } from '../utils/paths.js';
import { restoreTerminal } from '../utils/terminal.js';
import type { AccountLease, AccountsFile, HealthFailureReason, HealthFile, RelayAccount, RunnerOptions, SpawnResult, StateFile } from '../types.js';

export interface ProcessHandle {
  onData(callback: (chunk: string) => void): void;
  onExit(callback: (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): void;
  kill(): void;
  write?(chunk: string | Buffer): void;
  resize?(cols: number, rows: number): void;
}

export interface ProcessAdapter {
  readonly supportsInteractiveTui?: boolean;
  spawn(command: string, args: string[], options: SpawnOptions): ProcessHandle;
}

export interface SpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface CodexSpawnTarget {
  command: string;
  argsPrefix: string[];
  shell?: boolean;
}

export interface RunnerDependencies {
  paths?: RunnerDataPaths;
  adapter?: ProcessAdapter;
  output?: (chunk: string) => void;
  outputStream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadStream;
  now?: () => Date;
  leaseHeartbeatMs?: number;
}

type RunnerDataPaths = Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health' | 'codexHome' | 'lock'>>;

interface RunAttemptResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  shouldRotate: boolean;
  sessionId?: string;
  retryAfterMs?: number;
  reason?: HealthFailureReason;
}

type NodePtyModule = typeof import('node-pty');
type NodePtyLoader = () => NodePtyModule;
const nonInteractiveSubcommands = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'marketplace',
  'completion',
  'sandbox',
  'debug',
  'apply',
  'a',
  'cloud',
  'features',
  'doctor',
  'help'
]);
const codexOptionsWithValue = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-C',
  '--cd',
  '--add-dir',
  '-i',
  '--image'
]);
const ACCOUNT_LEASE_TTL_MS = 2 * 60 * 1000;
const ACCOUNT_LEASE_HEARTBEAT_MS = 30 * 1000;

export function resolveCodexSpawnTarget(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): CodexSpawnTarget {
  const explicitPath = env.CODEX_RELAY_CODEX_PATH?.trim();
  if (explicitPath) {
    return resolveExplicitCodexTarget(explicitPath, platform);
  }

  if (platform !== 'win32') {
    return { command: 'codex', argsPrefix: [] };
  }

  const pathValue = getEnvPath(env);
  if (!pathValue) {
    return { command: 'codex', argsPrefix: [] };
  }

  for (const entry of splitPathEntries(pathValue, platform)) {
    const cmdShim = join(entry, 'codex.cmd');
    if (isFile(cmdShim)) {
      const script = resolveNpmCodexScript(entry);
      if (script) {
        return { command: process.execPath, argsPrefix: [script] };
      }
      return { command: cmdShim, argsPrefix: [], shell: true };
    }

    const exe = join(entry, 'codex.exe');
    if (isFile(exe)) {
      return { command: exe, argsPrefix: [] };
    }
  }

  return { command: 'codex', argsPrefix: [] };
}

function resolveExplicitCodexTarget(command: string, platform: NodeJS.Platform): CodexSpawnTarget {
  if (platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    const script = resolveNpmCodexScript(dirname(command));
    if (script) {
      return { command: process.execPath, argsPrefix: [script] };
    }
    return { command, argsPrefix: [], shell: true };
  }
  return { command, argsPrefix: [] };
}

function getEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') {
      return env[key];
    }
  }
  return undefined;
}

function splitPathEntries(pathValue: string, platform: NodeJS.Platform): string[] {
  const separator = platform === 'win32' ? ';' : ':';
  return pathValue
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function resolveNpmCodexScript(binDir: string): string | undefined {
  const script = join(binDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return isFile(script) ? script : undefined;
}

function resolveProcessSpawnTarget(command: string, env: NodeJS.ProcessEnv): CodexSpawnTarget {
  return command === 'codex' ? resolveCodexSpawnTarget(env) : { command, argsPrefix: [] };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function buildCodexEnv(
  account: RelayAccount,
  baseEnv: NodeJS.ProcessEnv = process.env,
  codexHome?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    OPENAI_API_KEY: account.apiKey
  };
  if (codexHome) {
    env.CODEX_HOME = codexHome;
  }
  return env;
}

export function buildCodexArgs(
  account: RelayAccount,
  codexArgs: string[],
  resume?: { sessionId?: string; prompt: string }
): string[] {
  const args = ['-c', `openai_base_url="${account.baseUrl}"`];
  if (account.model) {
    args.push('-m', account.model);
  }
  if (resume) {
    const execMode = isExecCodexInvocation(codexArgs);
    if (execMode) {
      args.push('exec');
    }
    args.push('resume');
    if (!execMode) {
      args.push('--no-alt-screen');
    }
    if (resume.sessionId) {
      args.push(resume.sessionId);
    } else {
      args.push('--last');
    }
    args.push(resume.prompt);
    return args;
  }
  return [...args, ...withInlineTerminalMode(codexArgs)];
}

function withInlineTerminalMode(codexArgs: string[]): string[] {
  if (codexArgs.includes('--no-alt-screen') || isNonInteractiveCodexInvocation(codexArgs)) {
    return codexArgs;
  }
  return [...codexArgs, '--no-alt-screen'];
}

function isNonInteractiveCodexInvocation(codexArgs: string[]): boolean {
  const firstPositional = findFirstPositionalArg(codexArgs);
  return firstPositional !== undefined && nonInteractiveSubcommands.has(firstPositional);
}

function isExecCodexInvocation(codexArgs: string[]): boolean {
  const firstPositional = findFirstPositionalArg(codexArgs);
  return firstPositional === 'exec' || firstPositional === 'e';
}

function findFirstPositionalArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === '--') {
      return undefined;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const optionName = arg.slice(0, arg.indexOf('='));
      if (codexOptionsWithValue.has(optionName)) {
        continue;
      }
    }
    if (codexOptionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    return arg;
  }
  return undefined;
}

export async function runManagedCodex(
  options: RunnerOptions,
  dependencies: RunnerDependencies = {}
): Promise<SpawnResult> {
  const paths = dependencies.paths ?? resolveDataPaths();
  const adapter = dependencies.adapter ?? createDefaultProcessAdapter();
  const output = dependencies.output ?? ((chunk: string) => process.stdout.write(chunk));
  const outputStream = dependencies.outputStream ?? process.stdout;
  const env = dependencies.env ?? process.env;
  const input = dependencies.input ?? process.stdin;
  const now = dependencies.now ?? (() => new Date());
  const leaseHeartbeatMs = dependencies.leaseHeartbeatMs ?? ACCOUNT_LEASE_HEARTBEAT_MS;
  const healthPath = resolveHealthPath(paths);
  const ownerId = createLeaseOwnerId();
  const codexHome = resolveRunCodexHome(resolveCodexHomePath(paths), ownerId);
  await mkdir(codexHome, { recursive: true });
  let sessionId: string | undefined;
  let hasInterruptedSession = false;
  const attempted = new Set<string>();
  let reserved = await reserveNextAccount({
    paths,
    healthPath,
    ownerId,
    attempted,
    requestedAccount: options.accountName,
    cwd: options.cwd,
    now
  });
  const stopHeartbeat = startLeaseHeartbeat(paths, ownerId, now, leaseHeartbeatMs);

  try {
    while (reserved) {
      const account = reserved.account;
      attempted.add(account.name);
      if (reserved.shared) {
        output(formatSharedAccountNotice(account.name));
      }

      const attemptArgs: RunAttemptArgs = {
        adapter,
        account,
        codexArgs: options.codexArgs,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env,
        codexHome,
        input,
        output,
        outputStream,
        customQuotaPatterns: reserved.accountsFile.customQuotaPatterns
      };
      if (hasInterruptedSession) {
        attemptArgs.resume = sessionId ? { sessionId, prompt: 'Continue' } : { prompt: 'Continue' };
      }

      output(formatAccountNotice(account, attemptArgs.resume !== undefined));
      const result = await runAttempt(attemptArgs);

      sessionId = result.sessionId ?? sessionId;

      if (!result.shouldRotate) {
        await recordSuccessfulAttempt(paths, healthPath, account.name, now());
        restoreTerminal(outputStream);
        const success: SpawnResult = {
          exitCode: result.exitCode,
          signal: result.signal,
          usedAccount: account.name
        };
        if (sessionId) {
          success.sessionId = sessionId;
        }
        return success;
      }

      hasInterruptedSession = true;
      reserved = await recordFailedAttemptAndReserveNext({
        paths,
        healthPath,
        ownerId,
        failedAccount: account,
        attempted,
        requestedAccount: options.accountName,
        cwd: options.cwd,
        result,
        now
      });
      output(formatRotationNotice(account.name, reserved?.account.name, result.reason ?? 'unknown'));
    }

    restoreTerminal(outputStream);
    throw new Error('All relay accounts are unavailable or exhausted.');
  } finally {
    await stopHeartbeat();
    await releaseAccountLease(paths, ownerId);
  }
}

function resolveHealthPath(paths: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health'>>): string {
  return paths.health ?? join(dirname(paths.state), 'health.json');
}

function resolveCodexHomePath(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'codexHome'>>): string {
  return paths.codexHome ?? join(dirname(paths.state), 'codex-home');
}

function resolveRunCodexHome(codexHomeRoot: string, ownerId: string): string {
  return join(codexHomeRoot, 'runs', ownerId.replace(/[^a-zA-Z0-9._-]/g, '-'));
}

interface ReservedAccount {
  account: RelayAccount;
  accountsFile: AccountsFile;
  shared: boolean;
}

interface ReserveNextInput {
  paths: RunnerDataPaths;
  healthPath: string;
  ownerId: string;
  attempted: Set<string>;
  requestedAccount?: string | undefined;
  cwd?: string | undefined;
  now: () => Date;
}

interface FailureReserveInput extends ReserveNextInput {
  failedAccount: RelayAccount;
  result: RunAttemptResult;
}

async function reserveNextAccount(input: ReserveNextInput): Promise<ReservedAccount | undefined> {
  return withStoreLock(input.paths, async () => reserveNextAccountLocked(input));
}

async function reserveNextAccountLocked(input: ReserveNextInput): Promise<ReservedAccount | undefined> {
  let accountsFile = await loadAccountsFile(input.paths.accounts);
  if (accountsFile.accounts.length === 0) {
    throw new Error('No relay accounts configured. Put your relay accounts in data.json, then run `codex-relay setup` first.');
  }

  const currentTime = input.now();
  const retirement = await retireExpiredHealthAccounts(input.healthPath, accountsFile, currentTime);
  if (retirement.retiredNames.length > 0) {
    accountsFile = retirement.accountsFile;
    await saveAccountsFile(input.paths.accounts, accountsFile);
  }
  if (accountsFile.accounts.length === 0) {
    throw new Error('All relay accounts were retired after failing continuously for ten days.');
  }

  const state = await loadPrunedState(input.paths, currentTime);
  const health = await loadHealthFile(input.healthPath);
  const selected = selectLeaseAwareAccount({
    accountsFile,
    state,
    health,
    attempted: input.attempted,
    requestedAccount: input.requestedAccount,
    ownerId: input.ownerId,
    now: currentTime
  });
  if (!selected) {
    return undefined;
  }

  const lease = buildAccountLease({
    state,
    ownerId: input.ownerId,
    accountName: selected.account.name,
    cwd: input.cwd,
    now: currentTime
  });
  await saveStateFile(input.paths.state, {
    ...state,
    leases: {
      ...state.leases,
      [input.ownerId]: lease
    },
    updatedAt: lease.updatedAt
  });

  return {
    account: selected.account,
    accountsFile,
    shared: selected.shared
  };
}

async function recordFailedAttemptAndReserveNext(input: FailureReserveInput): Promise<ReservedAccount | undefined> {
  return withStoreLock(input.paths, async () => {
    const failureAt = input.now();
    let accountsFile = await loadAccountsFile(input.paths.accounts);
    await recordAccountFailure(input.healthPath, {
      accountName: input.failedAccount.name,
      baseUrl: input.failedAccount.baseUrl,
      reason: input.result.reason ?? 'unknown',
      now: failureAt,
      ...(input.result.retryAfterMs !== undefined ? { retryAfterMs: input.result.retryAfterMs } : {})
    });

    const latestRetirement = await retireExpiredHealthAccounts(input.healthPath, accountsFile, failureAt);
    if (latestRetirement.retiredNames.length > 0) {
      accountsFile = latestRetirement.accountsFile;
      await saveAccountsFile(input.paths.accounts, accountsFile);
    }

    if (input.result.retryAfterMs) {
      const availableAt = new Date(failureAt.getTime() + input.result.retryAfterMs);
      await markRetryAvailability(input.paths.state, input.failedAccount.name, {
        displayText: availableAt.toLocaleString(),
        availableAt: availableAt.toISOString()
      });
    }

    return reserveNextAccountLocked(input);
  });
}

async function recordSuccessfulAttempt(
  paths: RunnerDataPaths,
  healthPath: string,
  accountName: string,
  successAt: Date
): Promise<void> {
  await withStoreLock(paths, async () => {
    const accountsFile = await loadAccountsFile(paths.accounts);
    const accountIndex = getAccountIndex(accountsFile, accountName);
    await updateSuccessfulAccount(paths.state, accountName, Math.max(0, accountIndex));
    await recordAccountSuccess(healthPath, accountName, successAt);
  });
}

async function releaseAccountLease(paths: RunnerDataPaths, ownerId: string): Promise<void> {
  await withStoreLock(paths, async () => {
    await removeAccountLease(paths.state, ownerId);
  });
}

function startLeaseHeartbeat(paths: RunnerDataPaths, ownerId: string, now: () => Date, intervalMs: number): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    inFlight = withStoreLock(paths, async () => {
      const currentTime = now();
      const state = await loadPrunedState(paths, currentTime);
      const currentLease = state.leases[ownerId];
      if (!currentLease) {
        return;
      }
      const nextLease = buildAccountLease({
        state,
        ownerId,
        accountName: currentLease.accountName,
        cwd: currentLease.cwd,
        now: currentTime
      });
      await saveStateFile(paths.state, {
        ...state,
        leases: {
          ...state.leases,
          [ownerId]: nextLease
        },
        updatedAt: nextLease.updatedAt
      });
    }).catch(() => undefined);
  }, intervalMs);
  heartbeat.unref?.();
  return async () => {
    clearInterval(heartbeat);
    await inFlight;
  };
}

async function loadPrunedState(paths: RunnerDataPaths, now: Date): Promise<StateFile> {
  const current = await loadStateFile(paths.state);
  const pruned = pruneExpiredLeases(current, now);
  if (pruned === current) {
    return current;
  }
  const updated = {
    ...pruned,
    updatedAt: now.toISOString()
  };
  await saveStateFile(paths.state, updated);
  return updated;
}

function selectLeaseAwareAccount(input: {
  accountsFile: AccountsFile;
  state: StateFile;
  health: HealthFile;
  attempted: Set<string>;
  requestedAccount?: string | undefined;
  ownerId: string;
  now: Date;
}): { account: RelayAccount; shared: boolean } | undefined {
  const rotationOrder = buildRotationOrder(input.accountsFile, input.state, input.requestedAccount);
  const leasedAccountNames = new Set<string>();
  for (const lease of Object.values(input.state.leases)) {
    if (lease.ownerId !== input.ownerId && new Date(lease.expiresAt).getTime() > input.now.getTime()) {
      leasedAccountNames.add(lease.accountName);
    }
  }

  const sharedCandidates: Array<{ account: RelayAccount; shared: true }> = [];
  for (const name of rotationOrder) {
    if (input.attempted.has(name)) {
      continue;
    }
    const account = getAccountByName(input.accountsFile, name);
    if (!account || !isAccountAvailable(account.name, input.state, input.now, input.health)) {
      continue;
    }
    const shared = leasedAccountNames.has(name);
    if (shared && name !== input.requestedAccount) {
      sharedCandidates.push({ account, shared: true });
      continue;
    }
    return { account, shared };
  }

  return sharedCandidates[0];
}

function buildAccountLease(input: {
  state: StateFile;
  ownerId: string;
  accountName: string;
  now: Date;
  cwd?: string | undefined;
}): AccountLease {
  const existing = input.state.leases[input.ownerId];
  const startedAt = existing?.accountName === input.accountName ? existing.startedAt : input.now.toISOString();
  const lease: AccountLease = {
    accountName: input.accountName,
    ownerId: input.ownerId,
    pid: process.pid,
    startedAt,
    updatedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + ACCOUNT_LEASE_TTL_MS).toISOString()
  };
  if (input.cwd !== undefined) {
    lease.cwd = input.cwd;
  } else if (existing?.cwd) {
    lease.cwd = existing.cwd;
  }
  return lease;
}

function createLeaseOwnerId(): string {
  return `${process.pid}-${randomUUID()}`;
}

function formatSharedAccountNotice(accountName: string): string {
  return `\n[codex-relay] ${accountName} is already in use in another terminal; sharing this account because the pool is currently tight.\n`;
}

function formatRotationNotice(from: string, to: string | undefined, reason: HealthFailureReason): string {
  const target = to ?? 'no available account';
  return `\n[codex-relay] ${from} failed (${reason}); switching to ${target} and resuming the conversation.\n`;
}

function formatAccountNotice(account: RelayAccount, isResume: boolean): string {
  const action = isResume ? 'resuming with' : 'using';
  const model = account.model ? `, model ${account.model}` : '';
  return `\n[codex-relay] ${action} ${account.name} (key ${maskApiKey(account.apiKey)}, baseUrl ${account.baseUrl}${model}).\n`;
}

function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.length <= 4) {
    return '****';
  }
  if (key.length <= 8) {
    return `${key.slice(0, 2)}...${key.slice(-2)}`;
  }
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

interface RunAttemptArgs {
  adapter: ProcessAdapter;
  account: RelayAccount;
  codexArgs: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  codexHome: string;
  input: NodeJS.ReadStream;
  output: (chunk: string) => void;
  outputStream: NodeJS.WriteStream;
  customQuotaPatterns: string[];
  resume?: { sessionId?: string; prompt: string };
}

async function runAttempt(args: RunAttemptArgs): Promise<RunAttemptResult> {
  if (isInteractiveTuiAttempt(args.codexArgs, args.resume) && args.adapter.supportsInteractiveTui !== true) {
    throw new Error('Interactive Codex TUI requires node-pty. Install optional dependencies or use `codex-relay exec ...` for non-interactive runs.');
  }

  return new Promise((resolve) => {
    let settled = false;
    let shouldRotate = false;
    let mediumSignalSeen = false;
    let sessionId: string | undefined;
    let retryAfterMs: number | undefined;
    let reason: HealthFailureReason | undefined;
    const terminalSize = getTerminalSize(args.outputStream);
    const spawnOptions: SpawnOptions = {
      env: buildCodexEnv(args.account, args.env, args.codexHome),
      cols: terminalSize.cols,
      rows: terminalSize.rows
    };
    if (args.cwd) {
      spawnOptions.cwd = args.cwd;
    }
    const handle = args.adapter.spawn('codex', buildCodexArgs(args.account, args.codexArgs, args.resume), spawnOptions);
    const forwardInput = (chunk: Buffer | string) => handle.write?.(chunk);
    const restoreInputMode = enterRawMode(args.input);
    const forwardResize = () => {
      const nextSize = getTerminalSize(args.outputStream);
      handle.resize?.(nextSize.cols, nextSize.rows);
    };
    args.input.on('data', forwardInput);
    args.outputStream.on('resize', forwardResize);

    handle.onData((chunk) => {
      args.output(chunk);
      sessionId = extractSessionId(chunk) ?? sessionId;
      const match = detectOutput(chunk, args.customQuotaPatterns);
      retryAfterMs = match.retryAfterMs ?? retryAfterMs;
      reason = match.reason ?? reason;
      if (match.confidence === 'high') {
        shouldRotate = true;
        handle.kill();
      } else if (match.confidence === 'medium') {
        mediumSignalSeen = true;
      }
    });

    handle.onExit((exit) => {
      if (settled) {
        return;
      }
      settled = true;
      args.input.off('data', forwardInput);
      args.outputStream.off('resize', forwardResize);
      restoreInputMode?.();
      const failed = exit.exitCode !== 0 && exit.exitCode !== null;
      resolve({
        exitCode: exit.exitCode,
        signal: exit.signal,
        shouldRotate: shouldRotate || (mediumSignalSeen && failed),
        ...(sessionId ? { sessionId } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(reason ? { reason } : {})
      });
    });
  });
}

function isInteractiveTuiAttempt(codexArgs: string[], resume?: { sessionId?: string; prompt: string }): boolean {
  if (resume) {
    return !isExecCodexInvocation(codexArgs);
  }
  return !isNonInteractiveCodexInvocation(codexArgs);
}

function getTerminalSize(output: NodeJS.WriteStream): { cols: number; rows: number } {
  return {
    cols: Math.max(1, output.columns ?? 80),
    rows: Math.max(1, output.rows ?? 24)
  };
}

function enterRawMode(input: NodeJS.ReadStream): (() => void) | undefined {
  const ttyInput = input as NodeJS.ReadStream & {
    setRawMode?: (value: boolean) => void;
    isRaw?: boolean;
    resume?: () => void;
    pause?: () => void;
  };

  if (!ttyInput.isTTY || typeof ttyInput.setRawMode !== 'function') {
    return undefined;
  }

  const previousRawMode = ttyInput.isRaw === true;
  ttyInput.setRawMode(true);
  ttyInput.resume?.();

  return () => {
    ttyInput.setRawMode?.(previousRawMode);
    if (!previousRawMode) {
      ttyInput.pause?.();
    }
  };
}

export function createDefaultProcessAdapter(loadPty: NodePtyLoader = requireNodePty): ProcessAdapter {
  try {
    return new PtyProcessAdapter(loadPty());
  } catch {
    return new NodeProcessAdapter();
  }
}

class PtyProcessAdapter implements ProcessAdapter {
  public readonly supportsInteractiveTui = true;

  constructor(private readonly ptyModule: NodePtyModule) {}

  spawn(command: string, args: string[], options: SpawnOptions): ProcessHandle {
    const target = resolveProcessSpawnTarget(command, options.env);
    const terminal = this.ptyModule.spawn(target.command, [...target.argsPrefix, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    });
    return new PtyProcessHandle(terminal);
  }
}

class PtyProcessHandle implements ProcessHandle {
  constructor(private readonly terminal: import('node-pty').IPty) {}

  onData(callback: (chunk: string) => void): void {
    this.terminal.onData(callback);
  }

  onExit(callback: (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.terminal.onExit((event) => callback({ exitCode: event.exitCode, signal: null }));
  }

  kill(): void {
    this.terminal.kill();
  }

  write(chunk: string | Buffer): void {
    this.terminal.write(chunk.toString());
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }
}

function requireNodePty(): NodePtyModule {
  const require = createRequire(import.meta.url);
  return require('node-pty') as typeof import('node-pty');
}

class NodeProcessAdapter implements ProcessAdapter {
  public readonly supportsInteractiveTui = false;

  spawn(command: string, args: string[], options: SpawnOptions): ProcessHandle {
    const target = resolveProcessSpawnTarget(command, options.env);
    return new ChildProcessHandle(target.command, [...target.argsPrefix, ...args], options, target.shell === true);
  }
}

class ChildProcessHandle extends EventEmitter implements ProcessHandle {
  private readonly child;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: SpawnOptions,
    private readonly shell: boolean
  ) {
    super();
    this.child = spawnChild(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.shell
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.emit('data', chunk.toString('utf8')));
    this.child.stderr?.on('data', (chunk: Buffer) => this.emit('data', chunk.toString('utf8')));
    this.child.on('exit', (exitCode, signal) => this.emit('exit', { exitCode, signal }));
  }

  onData(callback: (chunk: string) => void): void {
    this.on('data', callback);
  }

  onExit(callback: (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.on('exit', callback);
  }

  kill(): void {
    this.child.kill();
  }

  write(chunk: string | Buffer): void {
    this.child.stdin?.write(chunk);
  }
}
