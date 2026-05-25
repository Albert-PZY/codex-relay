import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { loadAccountsFile, saveAccountsFile } from './accounts.js';
import { detectOutput, extractSessionId } from './detector.js';
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
import { buildRotationOrder, getAccountByName, getAccountIndex, isAccountAvailable } from './rotator.js';
import { appendRotationLog } from './rotation-log.js';
import { withStoreLock } from './store-lock.js';
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from '../utils/atomic.js';
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

type RunnerDataPaths = Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health' | 'codexHome' | 'instances' | 'lock' | 'rotationLog'>>;

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
type SessionCandidate = {
  id: string;
  cwd: string | null;
  timestampMs: number;
};
type ResumeRequest = {
  sessionId: string;
  prompt: string;
};
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
const OUTPUT_DETECTION_BUFFER_LIMIT = 8192;
const ROTATION_EXIT_FALLBACK_MS = 250;
const HIGH_CONFIDENCE_GRACEFUL_ROTATION_MS = 800;
const SESSION_DISCOVERY_POLL_INTERVAL_MS = 50;
const SESSION_DISCOVERY_TIMEOUT_MS = 1_000;
const SESSION_HISTORY_TAIL_BYTES = 64 * 1024;

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
  resume?: ResumeRequest
): string[] {
  const args: string[] = [];
  if (account.model) {
    args.push('-m', account.model);
  }
  if (resume) {
    const execMode = isExecCodexInvocation(codexArgs);
    if (execMode) {
      args.push('exec');
    }
    if (!execMode) {
      args.push('--no-alt-screen');
    }
    args.push('resume');
    args.push(resume.sessionId);
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
  const rotationLogPath = resolveRotationLogPath(paths);
  const ownerId = createLeaseOwnerId();
  const runId = buildRunId();
  const sourceCodexHome = resolveCodexHomePath(paths);
  const instanceDir = resolveInstanceCodexHome(paths, runId);
  const effectiveCwd = options.cwd ?? process.cwd();
  const pendingResume = await loadPendingResumeForCwd(paths, effectiveCwd, options.codexArgs);
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

      if (!overlayPrepared) {
        await prepareRunScopedCodexHome(instanceDir, sourceCodexHome, account);
        overlayPrepared = true;
      } else {
        await writeRunScopedAccountFiles(instanceDir, account);
      }
      output(formatAccountNotice(account, attemptArgs.resume !== undefined));

      let knownSessionIds = new Map<string, number>();
      let launchStartedAt = 0;
      if (!sessionId) {
        knownSessionIds = await snapshotKnownSessionIds(instanceDir);
        launchStartedAt = Date.now();
      }

      const result = await runAttempt(attemptArgs);

      sessionId = result.sessionId ?? sessionId;
      if (!sessionId) {
        const discoveredSessionId = await waitForSessionId({
          instanceDir,
          workspaceDir: effectiveCwd,
          launchStartedAt,
          knownSessionIds,
          timeoutMs: result.shouldRotate ? SESSION_DISCOVERY_TIMEOUT_MS : 0
        });
        if (discoveredSessionId) {
          sessionId = discoveredSessionId;
        }
      }

      if (!result.shouldRotate) {
        await recordSuccessfulAttempt(paths, healthPath, account.name, now(), true);
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

function resolveCodexHomePath(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'codexHome'>>): string {
  return paths.codexHome ?? join(dirname(paths.state), 'codex-home');
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
    throw new Error('All relay accounts were retired after failing continuously for ten days.');
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
  accountName: string,
  successAt: Date,
  clearPendingResume = false
): Promise<void> {
  await withStoreLock(paths, async () => {
    const accountsFile = await loadAccountsFile(paths.accounts);
    const accountIndex = getAccountIndex(accountsFile, accountName);
    const state = await loadStateFile(paths.state);
    const nextState: StateFile = {
      ...state,
      currentIndex: Math.max(0, accountIndex),
      lastSuccessfulAccount: accountName,
      updatedAt: successAt.toISOString()
    };
    if (clearPendingResume) {
      delete nextState.pendingResume;
    }
    await saveStateFile(paths.state, nextState);
    await recordAccountSuccess(healthPath, accountName, successAt);
  });
}

async function loadPendingResumeForCwd(
  paths: RunnerDataPaths,
  cwd: string,
  codexArgs: string[]
): Promise<StateFile['pendingResume']> {
  if (codexArgs.length > 0) {
    return undefined;
  }
  return withStoreLock(paths, async () => {
    const state = await loadStateFile(paths.state);
    const pendingResume = state.pendingResume;
    if (!pendingResume) {
      return undefined;
    }
    if (pendingResume.cwd && !isSameCwd(pendingResume.cwd, cwd)) {
      return undefined;
    }
    return pendingResume;
  });
}

async function savePendingResume(paths: RunnerDataPaths, pendingResume: NonNullable<StateFile['pendingResume']>): Promise<void> {
  await withStoreLock(paths, async () => {
    const state = await loadStateFile(paths.state);
    await saveStateFile(paths.state, {
      ...state,
      pendingResume,
      updatedAt: pendingResume.updatedAt
    });
  });
}

function isSameCwd(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right;
}

function resolveInstancesRoot(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'instances'>>): string {
  return paths.instances ?? join(dirname(paths.state), 'instances');
}

function resolveInstanceCodexHome(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'instances'>>, runId: string): string {
  return join(resolveInstancesRoot(paths), runId);
}

async function prepareRunScopedCodexHome(
  instanceDir: string,
  sourceCodexHome: string,
  account: RelayAccount
): Promise<void> {
  await mkdir(sourceCodexHome, { recursive: true });
  await ensureSourceCodexHomeLayout(sourceCodexHome);
  await rm(instanceDir, { recursive: true, force: true });
  await mkdir(instanceDir, { recursive: true });

  const entries = await readdir(sourceCodexHome, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'auth.json' || entry.name === 'config.toml' || entry.name === 'models_cache.json') {
      continue;
    }

    const target = join(sourceCodexHome, entry.name);
    const link = join(instanceDir, entry.name);
    await createOverlayEntry(target, link, entry.isDirectory());
  }

  await copyOptionalFile(join(sourceCodexHome, 'config.toml'), join(instanceDir, 'config.toml'));
  await writeCodexAuth(join(instanceDir, 'auth.json'), account.apiKey);
  await writeCodexConfig(join(instanceDir, 'config.toml'), account.baseUrl);
}

async function ensureSourceCodexHomeLayout(sourceCodexHome: string): Promise<void> {
  const persistentFiles = ['history.jsonl', 'session_index.jsonl'];
  for (const fileName of persistentFiles) {
    const filePath = join(sourceCodexHome, fileName);
    try {
      await stat(filePath);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      await writeTextAtomic(filePath, '');
    }
  }

  await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
}

async function copyOptionalFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function createOverlayEntry(sourcePath: string, targetPath: string, isDirectory: boolean): Promise<void> {
  if (isDirectory) {
    await symlink(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }

  try {
    await link(sourcePath, targetPath);
    return;
  } catch {
    try {
      await symlink(sourcePath, targetPath, 'file');
      return;
    } catch {
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function writeRunScopedAccountFiles(instanceDir: string, account: RelayAccount): Promise<void> {
  await writeCodexAuth(join(instanceDir, 'auth.json'), account.apiKey);
  await writeCodexConfig(join(instanceDir, 'config.toml'), account.baseUrl);
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

async function snapshotKnownSessionIds(instanceDir: string): Promise<Map<string, number>> {
  const candidates = await readSessionCandidates(instanceDir);
  return new Map(candidates.map((candidate) => [candidate.id, candidate.timestampMs]));
}

async function waitForSessionId(options: {
  instanceDir: string;
  workspaceDir: string;
  launchStartedAt: number;
  knownSessionIds: Map<string, number>;
  timeoutMs: number;
}): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);

  while (true) {
    const candidates = await readSessionCandidates(options.instanceDir);
    const discovered = selectBestSessionCandidate(
      candidates.filter((candidate) => isNewOrUpdatedSessionCandidate(candidate, options.knownSessionIds)),
      options.workspaceDir,
      options.launchStartedAt
    );
    if (discovered) {
      return discovered;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(SESSION_DISCOVERY_POLL_INTERVAL_MS);
  }
}

function isNewOrUpdatedSessionCandidate(candidate: SessionCandidate, knownSessionIds: Map<string, number>): boolean {
  const knownTimestampMs = knownSessionIds.get(candidate.id);
  return knownTimestampMs === undefined || candidate.timestampMs > knownTimestampMs;
}

async function readSessionCandidates(instanceDir: string): Promise<SessionCandidate[]> {
  const [fromFiles, fromIndex, fromHistory] = await Promise.all([
    readSessionCandidatesFromFiles(instanceDir),
    readSessionCandidatesFromIndex(instanceDir),
    readSessionCandidatesFromHistory(instanceDir)
  ]);
  return mergeSessionCandidates([...fromFiles, ...fromIndex, ...fromHistory]);
}

async function readSessionCandidatesFromFiles(instanceDir: string): Promise<SessionCandidate[]> {
  const sessionFiles = await collectSessionFiles(join(instanceDir, 'sessions'));
  const candidates: SessionCandidate[] = [];

  for (const sessionFile of sessionFiles) {
    const candidate = await readSessionCandidateFromFile(sessionFile);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function readSessionCandidateFromFile(sessionFile: string): Promise<SessionCandidate | undefined> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(sessionFile)).mtimeMs;
  } catch {
    return undefined;
  }

  const fileText = await readTextIfExists(sessionFile);
  const firstLine = fileText?.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine) {
    try {
      const parsed = JSON.parse(firstLine) as {
        type?: unknown;
        payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown };
      };
      if (parsed.type === 'session_meta' && typeof parsed.payload?.id === 'string') {
        return {
          id: parsed.payload.id,
          cwd: typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : null,
          timestampMs: parseDateMs(parsed.payload.timestamp) ?? mtimeMs
        };
      }
    } catch {
      // Fall back to filename extraction below.
    }
  }

  const idFromName = extractSessionIdFromFileName(sessionFile);
  return idFromName ? { id: idFromName, cwd: null, timestampMs: mtimeMs } : undefined;
}

async function readSessionCandidatesFromIndex(instanceDir: string): Promise<SessionCandidate[]> {
  const indexText = await readTextIfExists(join(instanceDir, 'session_index.jsonl'));
  if (!indexText) {
    return [];
  }

  const candidates: SessionCandidate[] = [];
  for (const line of indexText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { id?: unknown; updated_at?: unknown };
      const timestampMs = parseDateMs(parsed.updated_at);
      if (typeof parsed.id === 'string' && timestampMs !== null) {
        candidates.push({ id: parsed.id, cwd: null, timestampMs });
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

async function readSessionCandidatesFromHistory(instanceDir: string): Promise<SessionCandidate[]> {
  const historyText = await readTailTextIfExists(join(instanceDir, 'history.jsonl'), SESSION_HISTORY_TAIL_BYTES);
  if (!historyText) {
    return [];
  }

  const candidates: SessionCandidate[] = [];
  for (const line of historyText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as {
        session_id?: unknown;
        ts?: unknown;
        cwd?: unknown;
      };
      if (typeof parsed.session_id === 'string') {
        candidates.push({
          id: parsed.session_id,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
          timestampMs: parseTimestampMs(parsed.ts) ?? 0
        });
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

async function collectSessionFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectSessionFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [entryPath] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

function selectBestSessionCandidate(
  candidates: SessionCandidate[],
  workspaceDir: string,
  launchStartedAt: number
): string | undefined {
  const freshCandidates = candidates.filter((candidate) => candidate.timestampMs >= launchStartedAt - 60_000);
  const cwdMatched = freshCandidates.filter((candidate) => candidate.cwd === null || isSameCwd(candidate.cwd, workspaceDir));
  const ranked = (cwdMatched.length > 0 ? cwdMatched : freshCandidates).sort((left, right) => {
    const leftDelta = Math.abs(left.timestampMs - launchStartedAt);
    const rightDelta = Math.abs(right.timestampMs - launchStartedAt);
    if (leftDelta !== rightDelta) {
      return leftDelta - rightDelta;
    }
    return right.timestampMs - left.timestampMs;
  });
  return ranked[0]?.id;
}

function mergeSessionCandidates(candidates: SessionCandidate[]): SessionCandidate[] {
  const merged = new Map<string, SessionCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.id);
    if (!existing || candidate.timestampMs > existing.timestampMs) {
      merged.set(candidate.id, {
        id: candidate.id,
        cwd: candidate.cwd ?? existing?.cwd ?? null,
        timestampMs: candidate.timestampMs
      });
    }
  }
  return [...merged.values()];
}

function parseDateMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value > 1e12 ? value : value * 1000;
  }
  return parseDateMs(value);
}

function extractSessionIdFromFileName(filePath: string): string | undefined {
  return basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1];
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readTailTextIfExists(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      if (length <= 0) {
        return '';
      }

      const buffer = Buffer.alloc(length);
      const position = Math.max(0, size - length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeCodexAuth(filePath: string, apiKey: string): Promise<void> {
  let auth: Record<string, unknown> = {};
  try {
    auth = await readJsonFile<Record<string, unknown>>(filePath);
  } catch (error) {
    if (!isMissingFile(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  await writeJsonAtomic(filePath, {
    ...auth,
    OPENAI_API_KEY: apiKey
  });
}

async function writeCodexConfig(filePath: string, baseUrl: string): Promise<void> {
  let config = '';
  try {
    config = await readFile(filePath, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const provider = findTomlStringValue(config, 'model_provider') ?? 'openai';
  const nextConfig = setProviderBaseUrl(config, provider, baseUrl);
  await writeTextAtomic(filePath, nextConfig);
}

function setProviderBaseUrl(config: string, provider: string, baseUrl: string): string {
  const normalizedConfig = config.length > 0 ? config.replace(/\r\n/g, '\n') : defaultCodexConfig(provider);
  const escapedProvider = escapeRegExp(provider);
  const sectionPattern = new RegExp(`(^\\[model_providers\\.${escapedProvider}\\]\\n)([\\s\\S]*?)(?=^\\[|\\s*$)`, 'm');
  const match = sectionPattern.exec(normalizedConfig);
  if (!match) {
    const separator = normalizedConfig.endsWith('\n') ? '\n' : '\n\n';
    return `${normalizedConfig}${separator}[model_providers.${provider}]\nbase_url = ${tomlString(baseUrl)}\n`;
  }

  const header = match[1]!;
  const body = match[2]!;
  const updatedBody = /^base_url\s*=.*$/m.test(body)
    ? body.replace(/^base_url\s*=.*$/m, `base_url = ${tomlString(baseUrl)}`)
    : `base_url = ${tomlString(baseUrl)}\n${body}`;
  return `${normalizedConfig.slice(0, match.index)}${header}${updatedBody}${normalizedConfig.slice(match.index + match[0].length)}`;
}

function defaultCodexConfig(provider: string): string {
  return `model_provider = ${tomlString(provider)}\n`;
}

function findTomlStringValue(config: string, key: string): string | undefined {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, 'm');
  return pattern.exec(config)?.[1];
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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
    if (!account || !isAccountAvailable(account.name, input.now, input.health)) {
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
    let sessionId: string | undefined;
    let retryAfterMs: number | undefined;
    let reason: HealthFailureReason | undefined;
    let outputDetectionBuffer = '';
    let inlineNoticeWritten = false;
    let rotationFallback: NodeJS.Timeout | undefined;
    let gracefulRotationTimer: NodeJS.Timeout | undefined;
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
    };

    handle.onData((chunk) => {
      args.output(chunk);
      if (args.inlineNotice && !inlineNoticeWritten) {
        inlineNoticeWritten = true;
        args.output(args.inlineNotice);
      }
      outputDetectionBuffer = appendDetectionBuffer(outputDetectionBuffer, chunk);
      sessionId = extractSessionId(outputDetectionBuffer) ?? sessionId;
      const match = detectOutput(outputDetectionBuffer, args.customQuotaPatterns);
      retryAfterMs = match.retryAfterMs ?? retryAfterMs;
      reason = match.reason ?? reason;
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

function appendDetectionBuffer(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= OUTPUT_DETECTION_BUFFER_LIMIT
    ? next
    : next.slice(next.length - OUTPUT_DETECTION_BUFFER_LIMIT);
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
