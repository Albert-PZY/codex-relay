import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { loadAccountsFile, saveAccountsFile } from './accounts.js';
import {
  buildCodexArgs,
  buildCodexEnv,
  createDefaultProcessAdapter,
  isExecCodexInvocation,
  isNonInteractiveCodexInvocation,
  type ProcessAdapter,
  type ResumeRequest,
  type SpawnOptions
} from './codex-process.js';
import {
  prepareRunScopedCodexHome,
  resolveCodexHomePath,
  resolveInstanceCodexHome,
  writeRunScopedAccountFiles
} from './codex-home.js';
import {
  buildContextRecoveryCodexArgs,
  buildContextRecoveryInput,
  formatContextRecoveryNotice
} from './context-recovery.js';
import { detectOutput, extractSessionId, isMcpStartupPending } from './detector.js';
import {
  recordAccountFailure,
  recordAccountSuccess,
  retireExpiredHealthAccounts
} from './health.js';
import {
  loadStateFile,
  pruneExpiredLeases,
  saveStateFile
} from './state.js';
import { buildRotationOrder, getAccountByName, getAccountIndex, isRelayAccountAvailable } from './rotator.js';
import { appendRotationLog } from './rotation-log.js';
import { isSameCwd, snapshotKnownSessionIds, SESSION_DISCOVERY_TIMEOUT_MS, waitForSessionId } from './session-discovery.js';
import { withStoreLock } from './store-lock.js';
import { resolveDataPaths, type DataPaths } from '../utils/paths.js';
import { restoreTerminal } from '../utils/terminal.js';
import type { AccountLease, AccountsFile, DetectorReason, HealthFailureReason, HealthFile, PendingResume, RelayAccount, RunnerOptions, SpawnResult, StateFile } from '../types.js';

export {
  buildCodexArgs,
  buildCodexEnv,
  createDefaultProcessAdapter,
  resolveCodexSpawnTarget
} from './codex-process.js';
export type { CodexSpawnTarget, ProcessAdapter, ProcessHandle, SpawnOptions } from './codex-process.js';

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

type RunnerDataPaths = Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health' | 'codexHome' | 'instances' | 'lock' | 'rotationLog'>>;

interface RunAttemptResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  shouldRotate: boolean;
  sessionId?: string;
  rotateOnSessionDiscovery?: boolean;
  contextOverflow?: boolean;
  retryAfterMs?: number;
  reason?: HealthFailureReason;
}

const ACCOUNT_LEASE_TTL_MS = 2 * 60 * 1000;
const ACCOUNT_LEASE_HEARTBEAT_MS = 30 * 1000;
const OUTPUT_DETECTION_BUFFER_LIMIT = 8192;
const ROTATION_EXIT_FALLBACK_MS = 250;
const HIGH_CONFIDENCE_GRACEFUL_ROTATION_MS = 800;
const CONTEXT_OVERFLOW_EXIT_FALLBACK_MS = 250;
const CONVERSATION_INTERRUPTED_NOTICE = /Conversation interrupted - tell the model what to do differently\./i;
const ABNORMAL_CONTEXT_OVERFLOW_LINE =
  /^\s*(?:error:\s*)?(?:unexpected\s+status\s+413\b|HTTP\s*413\b\s*[: -]*\s*Payload\s+Too\s+Large\b|413\s+Payload\s+Too\s+Large\b)|\brequest\s+body\s+exceeds\s+your\s+tier\s+limit\b/i;
const MAX_CONTEXT_OVERFLOW_RECOVERIES = 1;

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
  const rotationLogPath = resolveRotationLogPath(paths);
  const ownerId = createLeaseOwnerId();
  const runId = buildRunId();
  const sourceCodexHome = resolveCodexHomePath(paths);
  const instanceDir = resolveInstanceCodexHome(paths, runId);
  const effectiveCwd = options.cwd ?? process.cwd();
  const pendingResume = options.disableResume ? undefined : await loadPendingResumeForCwd(paths, effectiveCwd, options.codexArgs);
  let sessionId = pendingResume?.sessionId;
  const resumePrompt = pendingResume?.prompt ?? 'Continue';
  const attempted = new Set<string>();
  let reserved = await reserveNextAccount({
    paths,
    healthPath,
    ownerId,
    attempted,
    requestedAccount: options.accountName,
    cwd: effectiveCwd,
    now
  });
  const stopHeartbeat = startLeaseHeartbeat(paths, ownerId, now, leaseHeartbeatMs);
  let overlayPrepared = false;
  let contextRecoveryCount = 0;
  let contextRecoveryArgs: string[] | undefined;

  try {
    while (reserved) {
      const account = reserved.account;
      attempted.add(account.name);
      if (reserved.shared) {
        output(formatSharedAccountNotice(account.name));
      }

      const recoveryArgs = contextRecoveryArgs;
      const attemptArgs: RunAttemptArgs = {
        adapter,
        account,
        codexArgs: recoveryArgs ?? options.codexArgs,
        cwd: effectiveCwd,
        env,
        codexHome: instanceDir,
        input,
        output,
        outputStream,
        customQuotaPatterns: reserved.accountsFile.customQuotaPatterns
      };
      if (sessionId) {
        attemptArgs.resume = { sessionId, prompt: resumePrompt };
        attemptArgs.inlineNotice = formatInlineAccountNotice(account);
      }
      if (recoveryArgs) {
        delete attemptArgs.resume;
        delete attemptArgs.inlineNotice;
      }

      if (!overlayPrepared) {
        await prepareRunScopedCodexHome(instanceDir, sourceCodexHome, account);
        overlayPrepared = true;
      } else {
        await writeRunScopedAccountFiles(instanceDir, account);
      }
      output(formatAccountNotice(account, attemptArgs.resume !== undefined));

      const knownSessionIds = await snapshotKnownSessionIds(instanceDir);
      const launchStartedAt = Date.now();

      const result = await runAttempt(attemptArgs);
      if (recoveryArgs) {
        contextRecoveryArgs = undefined;
      }

      const discoveredSessionId = await waitForSessionId({
        instanceDir,
        workspaceDir: effectiveCwd,
        launchStartedAt,
        knownSessionIds,
        timeoutMs: result.shouldRotate || result.rotateOnSessionDiscovery ? SESSION_DISCOVERY_TIMEOUT_MS : 0,
        selectionMode: sessionId ? 'latest' : 'closest-to-launch',
        currentSessionId: sessionId
      });
      if (discoveredSessionId) {
        sessionId = discoveredSessionId;
      } else {
        sessionId = result.sessionId ?? sessionId;
      }
      if (!result.shouldRotate && result.rotateOnSessionDiscovery && sessionId) {
        result.shouldRotate = true;
      }

      if (!result.shouldRotate) {
        await recordSuccessfulAttempt(paths, healthPath, account, now(), options.disableResume ? undefined : effectiveCwd);
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

      if (result.contextOverflow) {
        if (contextRecoveryCount >= MAX_CONTEXT_OVERFLOW_RECOVERIES) {
          restoreTerminal(outputStream);
          output('\n[codex-relay] Context is still too large after automatic recovery. Start a new shorter request or split the task.\n');
          return {
            exitCode: result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
            signal: result.signal,
            usedAccount: account.name,
            ...(sessionId ? { sessionId } : {})
          };
        }
        const recoveryInput = await buildContextRecoveryInput({
          instanceDir,
          workspaceDir: effectiveCwd,
          sessionId,
          codexArgs: options.codexArgs
        });
        contextRecoveryCount += 1;
        contextRecoveryArgs = buildContextRecoveryCodexArgs(recoveryInput);
        sessionId = undefined;
        await recordSuccessfulAttempt(paths, healthPath, account, now(), options.disableResume ? undefined : effectiveCwd);
        output(formatContextRecoveryNotice(recoveryInput));
        continue;
      }

      if (!sessionId) {
        await recordFailedAttempt(paths, healthPath, account, result, now);
        restoreTerminal(outputStream);
        output('\n[codex-relay] Unable to safely resume: no session id was captured for this run. Automatic rotation stopped instead of guessing another conversation.\n');
        return {
          exitCode: result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
          signal: result.signal,
          usedAccount: account.name
        };
      }

      await savePendingResume(paths, {
        sessionId,
        prompt: resumePrompt,
        cwd: effectiveCwd,
        updatedAt: now().toISOString()
      });
      reserved = await recordFailedAttemptAndReserveNext({
        paths,
        healthPath,
        rotationLogPath,
        ownerId,
        failedAccount: account,
        attempted,
        requestedAccount: options.accountName,
        cwd: effectiveCwd,
        result,
        sessionId,
        now
      });
      output(formatRotationNotice(account.name, reserved?.account.name, result.reason ?? 'unknown'));
    }

    restoreTerminal(outputStream);
    throw new Error('All relay accounts are unavailable or exhausted.');
  } finally {
    await stopHeartbeat();
    await releaseAccountLease(paths, ownerId);
    await rm(instanceDir, { recursive: true, force: true });
  }
}

function resolveHealthPath(paths: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health'>>): string {
  return paths.health ?? join(dirname(paths.state), 'health.json');
}


function resolveRotationLogPath(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'rotationLog'>>): string {
  return paths.rotationLog ?? join(dirname(paths.state), 'rotation.log');
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
  rotationLogPath: string;
  sessionId: string;
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
  const health = retirement.health;
  if (retirement.retiredNames.length > 0) {
    accountsFile = retirement.accountsFile;
    await saveAccountsFile(input.paths.accounts, accountsFile);
  }
  if (accountsFile.accounts.length === 0) {
    throw new Error('All relay accounts were retired after reaching the cooldown limit.');
  }

  const state = await loadPrunedState(input.paths, currentTime);
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
    await recordAccountFailure(input.healthPath, {
      accountName: input.failedAccount.name,
      apiKey: input.failedAccount.apiKey,
      baseUrl: input.failedAccount.baseUrl,
      reason: input.result.reason ?? 'unknown',
      now: failureAt,
      ...(input.result.retryAfterMs !== undefined ? { retryAfterMs: input.result.retryAfterMs } : {})
    });

    const reserved = await reserveNextAccountLocked(input);
    if (reserved) {
      const nextIndex = getAccountIndex(reserved.accountsFile, reserved.account.name);
      const state = await loadStateFile(input.paths.state);
      if (reserved.accountsFile.preferred === input.failedAccount.name) {
        await saveAccountsFile(input.paths.accounts, {
          ...reserved.accountsFile,
          preferred: reserved.account.name
        });
      }
      await saveStateFile(input.paths.state, {
        ...state,
        currentIndex: Math.max(0, nextIndex),
        lastSuccessfulAccount: reserved.account.name,
        updatedAt: failureAt.toISOString()
      });
      await appendRotationLog(input.rotationLogPath, {
        at: failureAt,
        from: input.failedAccount.name,
        to: reserved.account.name,
        reason: input.result.reason ?? 'unknown',
        resumeMode: 'session',
        sessionId: input.sessionId
      });
    }
    return reserved;
  });
}

async function recordSuccessfulAttempt(
  paths: RunnerDataPaths,
  healthPath: string,
  account: RelayAccount,
  successAt: Date,
  clearPendingResumeCwd?: string | undefined
): Promise<void> {
  await withStoreLock(paths, async () => {
    const accountsFile = await loadAccountsFile(paths.accounts);
    const accountName = account.name;
    const accountIndex = getAccountIndex(accountsFile, accountName);
    const state = await loadStateFile(paths.state);
    const nextState: StateFile = {
      ...state,
      currentIndex: Math.max(0, accountIndex),
      lastSuccessfulAccount: accountName,
      updatedAt: successAt.toISOString()
    };
    if (clearPendingResumeCwd !== undefined) {
      const pendingResumes = removePendingResumeForCwd(nextState.pendingResumes, clearPendingResumeCwd);
      if (pendingResumes) {
        nextState.pendingResumes = pendingResumes;
      } else {
        delete nextState.pendingResumes;
      }
    }
    await saveStateFile(paths.state, nextState);
    await recordAccountSuccess(healthPath, account, successAt);
  });
}

async function loadPendingResumeForCwd(
  paths: RunnerDataPaths,
  cwd: string,
  codexArgs: string[]
): Promise<PendingResume | undefined> {
  if (codexArgs.length > 0) {
    return undefined;
  }
  return withStoreLock(paths, async () => {
    const state = await loadStateFile(paths.state);
    const pendingResume = getPendingResumeForCwd(state, cwd);
    if (!pendingResume) {
      return undefined;
    }
    if (pendingResume.cwd && !isSameCwd(pendingResume.cwd, cwd)) {
      return undefined;
    }
    return pendingResume;
  });
}

async function savePendingResume(paths: RunnerDataPaths, pendingResume: PendingResume): Promise<void> {
  await withStoreLock(paths, async () => {
    const state = await loadStateFile(paths.state);
    const pendingResumes = {
      ...(state.pendingResumes ?? {}),
      [pendingResumeKey(pendingResume.cwd)]: pendingResume
    };
    await saveStateFile(paths.state, {
      ...state,
      pendingResumes,
      updatedAt: pendingResume.updatedAt
    });
  });
}

function getPendingResumeForCwd(state: StateFile, cwd: string): PendingResume | undefined {
  const pendingResumes = state.pendingResumes ?? {};
  return pendingResumes[pendingResumeKey(cwd)];
}

function removePendingResumeForCwd(
  pendingResumes: StateFile['pendingResumes'],
  cwd: string
): StateFile['pendingResumes'] {
  if (!pendingResumes) {
    return undefined;
  }
  const next = { ...pendingResumes };
  delete next[pendingResumeKey(cwd)];
  return next;
}

function pendingResumeKey(cwd: string | undefined): string {
  return cwd?.trim().toLowerCase() || '__global__';
}


async function recordFailedAttempt(
  paths: RunnerDataPaths,
  healthPath: string,
  account: RelayAccount,
  result: RunAttemptResult,
  now: () => Date
): Promise<void> {
  await withStoreLock(paths, async () => {
    await recordAccountFailure(healthPath, {
      accountName: account.name,
      apiKey: account.apiKey,
      baseUrl: account.baseUrl,
      reason: result.reason ?? 'unknown',
      now: now(),
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {})
    });
  });
}

function buildRunId(): string {
  return `${Date.now()}-${process.pid}-${randomUUID()}`;
}

async function releaseAccountLease(paths: RunnerDataPaths, ownerId: string): Promise<void> {
  await withStoreLock(paths, async () => {
    const state = await loadStateFile(paths.state);
    if (!state.leases[ownerId]) {
      return;
    }
    const leases = { ...state.leases };
    delete leases[ownerId];
    await saveStateFile(paths.state, {
      ...state,
      leases,
      updatedAt: new Date().toISOString()
    });
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
    if (!account || !isRelayAccountAvailable(account, input.now, input.health)) {
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

function formatInlineAccountNotice(account: RelayAccount): string {
  const model = account.model ? `, model ${account.model}` : '';
  return `\r\n[codex-relay] active relay account: ${account.name} (key ${maskApiKey(account.apiKey)}, baseUrl ${account.baseUrl}${model}).\r\n`;
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
  resume?: ResumeRequest;
  inlineNotice?: string;
}

async function runAttempt(args: RunAttemptArgs): Promise<RunAttemptResult> {
  if (isInteractiveTuiAttempt(args.codexArgs, args.resume) && args.adapter.supportsInteractiveTui !== true) {
    throw new Error('Interactive Codex TUI requires node-pty. Install optional dependencies or use `codex-relay exec ...` for non-interactive runs.');
  }

  return new Promise((resolve) => {
    let settled = false;
    let shouldRotate = false;
    let mediumSignalSeen = false;
    let contextOverflowSeen = false;
    let sessionId: string | undefined = args.resume?.sessionId;
    let retryAfterMs: number | undefined;
    let reason: HealthFailureReason | undefined;
    let outputDetectionBuffer = '';
    let inlineNoticeWritten = false;
    let rotationFallback: NodeJS.Timeout | undefined;
    let gracefulRotationTimer: NodeJS.Timeout | undefined;
    let contextOverflowFallback: NodeJS.Timeout | undefined;
    let contextOverflowRecoveryRequested = false;
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
    let userExitRequested = false;
    const forwardInput = (chunk: Buffer | string) => {
      if (isUserExitInput(chunk)) {
        userExitRequested = true;
      }
      handle.write?.(chunk);
    };
    const restoreInputMode = enterRawMode(args.input);
    const forwardResize = () => {
      const nextSize = getTerminalSize(args.outputStream);
      handle.resize?.(nextSize.cols, nextSize.rows);
    };
    args.input.on('data', forwardInput);
    args.outputStream.on('resize', forwardResize);

    const finish = (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (rotationFallback) {
        clearTimeout(rotationFallback);
        rotationFallback = undefined;
      }
      if (gracefulRotationTimer) {
        clearTimeout(gracefulRotationTimer);
        gracefulRotationTimer = undefined;
      }
      if (contextOverflowFallback) {
        clearTimeout(contextOverflowFallback);
        contextOverflowFallback = undefined;
      }
      args.input.off('data', forwardInput);
      args.outputStream.off('resize', forwardResize);
      restoreInputMode?.();
      const failed = exit.exitCode !== 0 && exit.exitCode !== null;
      const contextOverflow =
        contextOverflowSeen &&
        (failed || contextOverflowRecoveryRequested) &&
        !userExitRequested &&
        !isMcpStartupPending(outputDetectionBuffer);
      const shouldRotateAfterFailure =
        failed &&
        Boolean(sessionId) &&
        !contextOverflow &&
        !isMcpStartupPending(outputDetectionBuffer) &&
        !isConversationInterruptedOnly(outputDetectionBuffer);
      resolve({
        exitCode: exit.exitCode,
        signal: exit.signal,
        shouldRotate: contextOverflow ? true : userExitRequested ? false : shouldRotate || (mediumSignalSeen && failed) || shouldRotateAfterFailure,
        ...(sessionId ? { sessionId } : {}),
        ...(contextOverflow ? { contextOverflow: true } : {}),
        ...(userExitRequested || !shouldRotateAfterSessionDiscovery(failed, outputDetectionBuffer) ? {} : { rotateOnSessionDiscovery: true }),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...((contextOverflow || reason || shouldRotateAfterFailure) ? { reason: contextOverflow ? 'unknown' : reason ?? 'unknown' } : {})
      });
    };

    handle.onData((chunk) => {
      args.output(chunk);
      if (args.inlineNotice && !inlineNoticeWritten) {
        inlineNoticeWritten = true;
        args.output(args.inlineNotice);
      }
      outputDetectionBuffer = appendDetectionBuffer(outputDetectionBuffer, chunk);
      sessionId = extractSessionId(outputDetectionBuffer) ?? sessionId;
      if (isMcpStartupPending(outputDetectionBuffer)) {
        return;
      }
      const match = detectOutput(outputDetectionBuffer, args.customQuotaPatterns);
      retryAfterMs = match.retryAfterMs ?? retryAfterMs;
      if (match.reason === 'context_overflow') {
        contextOverflowSeen = true;
        if (!contextOverflowRecoveryRequested && isActionableContextOverflow(outputDetectionBuffer)) {
          contextOverflowRecoveryRequested = true;
          handle.kill();
          contextOverflowFallback = setTimeout(() => {
            finish({ exitCode: 1, signal: null });
          }, CONTEXT_OVERFLOW_EXIT_FALLBACK_MS);
        }
        return;
      }
      reason = toHealthFailureReason(match.reason) ?? reason;
      if (match.confidence === 'high') {
        shouldRotate = true;
        if (!gracefulRotationTimer) {
          gracefulRotationTimer = setTimeout(() => {
            gracefulRotationTimer = undefined;
            handle.kill();
          }, HIGH_CONFIDENCE_GRACEFUL_ROTATION_MS);
        }
        if (!rotationFallback) {
          rotationFallback = setTimeout(() => {
            handle.kill();
            finish({ exitCode: 1, signal: null });
          }, HIGH_CONFIDENCE_GRACEFUL_ROTATION_MS + ROTATION_EXIT_FALLBACK_MS);
        }
      } else if (match.confidence === 'medium') {
        mediumSignalSeen = true;
      }
    });

    handle.onExit(finish);
  });
}

function isUserExitInput(chunk: Buffer | string): boolean {
  const text = chunk.toString();
  return text.includes('\u0003') || text.includes('\u0004');
}

function appendDetectionBuffer(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= OUTPUT_DETECTION_BUFFER_LIMIT
    ? next
    : next.slice(next.length - OUTPUT_DETECTION_BUFFER_LIMIT);
}

function toHealthFailureReason(reason: DetectorReason | undefined): HealthFailureReason | undefined {
  return reason === 'context_overflow' ? undefined : reason;
}

function shouldRotateAfterSessionDiscovery(failed: boolean, output: string): boolean {
  return failed && !isMcpStartupPending(output) && !isConversationInterruptedOnly(output);
}

function isActionableContextOverflow(output: string): boolean {
  const cleanOutput = stripVTControlCharacters(output);
  if (CONVERSATION_INTERRUPTED_NOTICE.test(cleanOutput)) {
    return true;
  }
  return cleanOutput
    .split(/\r?\n/)
    .some((line) => ABNORMAL_CONTEXT_OVERFLOW_LINE.test(line.trim()));
}

function isConversationInterruptedOnly(output: string): boolean {
  const meaningfulLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !extractSessionId(line));
  return meaningfulLines.length > 0 && meaningfulLines.every((line) => CONVERSATION_INTERRUPTED_NOTICE.test(line));
}

function isInteractiveTuiAttempt(codexArgs: string[], resume?: ResumeRequest): boolean {
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
