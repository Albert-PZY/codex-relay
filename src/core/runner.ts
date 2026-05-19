import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
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
import { loadStateFile, markRetryAvailability, updateSuccessfulAccount } from './state.js';
import { buildRotationOrder, getAccountByName, getAccountIndex, isAccountAvailable } from './rotator.js';
import { resolveDataPaths, type DataPaths } from '../utils/paths.js';
import { restoreTerminal } from '../utils/terminal.js';
import type { HealthFailureReason, RelayAccount, RunnerOptions, SpawnResult } from '../types.js';

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

export interface RunnerDependencies {
  paths?: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health'>>;
  adapter?: ProcessAdapter;
  output?: (chunk: string) => void;
  outputStream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadStream;
  now?: () => Date;
}

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

export function buildCodexEnv(
  account: RelayAccount,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    OPENAI_API_KEY: account.apiKey
  };
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
  const healthPath = resolveHealthPath(paths);
  let accountsFile = await loadAccountsFile(paths.accounts);

  if (accountsFile.accounts.length === 0) {
    throw new Error('No relay accounts configured. Put your relay accounts in data.json, then run `codex-relay setup` first.');
  }

  const retirement = await retireExpiredHealthAccounts(healthPath, accountsFile, now());
  if (retirement.retiredNames.length > 0) {
    accountsFile = retirement.accountsFile;
    await saveAccountsFile(paths.accounts, accountsFile);
  }

  if (accountsFile.accounts.length === 0) {
    throw new Error('All relay accounts were retired after failing continuously for ten days.');
  }

  let state = await loadStateFile(paths.state);
  let health = await loadHealthFile(healthPath);
  const rotationOrder = buildRotationOrder(accountsFile, state, options.accountName);
  let sessionId: string | undefined;
  let hasInterruptedSession = false;
  const attempted = new Set<string>();

  for (const accountName of rotationOrder) {
    if (attempted.has(accountName)) {
      continue;
    }
    attempted.add(accountName);
    const account = getAccountByName(accountsFile, accountName);
    if (!account) {
      continue;
    }
    if (!isAccountAvailable(account.name, state, now(), health)) {
      continue;
    }

    const attemptArgs: RunAttemptArgs = {
      adapter,
      account,
      codexArgs: options.codexArgs,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
      input,
      output,
      outputStream,
      customQuotaPatterns: accountsFile.customQuotaPatterns
    };
    if (hasInterruptedSession) {
      attemptArgs.resume = sessionId ? { sessionId, prompt: 'Continue' } : { prompt: 'Continue' };
    }

    const result = await runAttempt(attemptArgs);

    sessionId = result.sessionId ?? sessionId;

    if (!result.shouldRotate) {
      const accountIndex = getAccountIndex(accountsFile, account.name);
      await updateSuccessfulAccount(paths.state, account.name, Math.max(0, accountIndex));
      await recordAccountSuccess(healthPath, account.name, now());
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
    const failureAt = now();
    health = await recordAccountFailure(healthPath, {
      accountName: account.name,
      baseUrl: account.baseUrl,
      reason: result.reason ?? 'unknown',
      now: failureAt,
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {})
    });

    const latestRetirement = await retireExpiredHealthAccounts(healthPath, accountsFile, failureAt);
    if (latestRetirement.retiredNames.length > 0) {
      accountsFile = latestRetirement.accountsFile;
      health = latestRetirement.health;
      await saveAccountsFile(paths.accounts, accountsFile);
    }

    if (result.retryAfterMs) {
      const availableAt = new Date(failureAt.getTime() + result.retryAfterMs);
      await markRetryAvailability(paths.state, account.name, {
        displayText: availableAt.toLocaleString(),
        availableAt: availableAt.toISOString()
      });
      state = await loadStateFile(paths.state);
    }
  }

  restoreTerminal(outputStream);
  throw new Error('All relay accounts are unavailable or exhausted.');
}

function resolveHealthPath(paths: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health'>>): string {
  return paths.health ?? join(dirname(paths.state), 'health.json');
}

interface RunAttemptArgs {
  adapter: ProcessAdapter;
  account: RelayAccount;
  codexArgs: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
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
      env: buildCodexEnv(args.account, args.env),
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
    const terminal = this.ptyModule.spawn(command, args, {
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
    return new ChildProcessHandle(command, args, options);
  }
}

class ChildProcessHandle extends EventEmitter implements ProcessHandle {
  private readonly child;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: SpawnOptions
  ) {
    super();
    this.child = spawnChild(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe']
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
