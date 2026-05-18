import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadAccountsFile } from './accounts.js';
import { detectOutput, extractSessionId } from './detector.js';
import { loadStateFile, markRetryAvailability, updateSuccessfulAccount } from './state.js';
import { buildRotationOrder, getAccountByName, getAccountIndex, isAccountAvailable } from './rotator.js';
import { resolveDataPaths, type DataPaths } from '../utils/paths.js';
import { restoreTerminal } from '../utils/terminal.js';
import type { RelayAccount, RunnerOptions, SpawnResult } from '../types.js';

export interface ProcessHandle {
  onData(callback: (chunk: string) => void): void;
  onExit(callback: (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): void;
  write(data: string): void;
  kill(): void;
}

export interface ProcessAdapter {
  spawn(command: string, args: string[], options: SpawnOptions): ProcessHandle;
}

export interface SpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface RunnerDependencies {
  paths?: Pick<DataPaths, 'accounts' | 'state'>;
  adapter?: ProcessAdapter;
  output?: (chunk: string) => void;
  input?: NodeJS.ReadStream;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface RunAttemptResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  shouldRotate: boolean;
  sessionId?: string;
  retryAfterMs?: number;
}

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
    args.push('resume');
    if (resume.sessionId) {
      args.push(resume.sessionId);
    } else {
      args.push('--last');
    }
    args.push(resume.prompt);
    return args;
  }
  return [...args, ...codexArgs];
}

export async function runManagedCodex(
  options: RunnerOptions,
  dependencies: RunnerDependencies = {}
): Promise<SpawnResult> {
  const paths = dependencies.paths ?? resolveDataPaths();
  const adapter = dependencies.adapter ?? createDefaultProcessAdapter();
  const output = dependencies.output ?? ((chunk: string) => process.stdout.write(chunk));
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const accountsFile = await loadAccountsFile(paths.accounts);

  if (accountsFile.accounts.length === 0) {
    throw new Error('No relay accounts configured. Put your relay keys in data.txt, then run `codex-relay setup` first.');
  }

  let state = await loadStateFile(paths.state);
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
    if (!isAccountAvailable(account.name, state, now())) {
      continue;
    }

    const attemptArgs: RunAttemptArgs = {
      adapter,
      account,
      codexArgs: options.codexArgs,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
      output,
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
      restoreTerminal();
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

    if (result.retryAfterMs) {
      const availableAt = new Date(now().getTime() + result.retryAfterMs);
      await markRetryAvailability(paths.state, account.name, {
        displayText: availableAt.toLocaleString(),
        availableAt: availableAt.toISOString()
      });
      state = await loadStateFile(paths.state);
      void state;
    }
  }

  restoreTerminal();
  throw new Error('All relay accounts are unavailable or exhausted.');
}

interface RunAttemptArgs {
  adapter: ProcessAdapter;
  account: RelayAccount;
  codexArgs: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  output: (chunk: string) => void;
  customQuotaPatterns: string[];
  resume?: { sessionId?: string; prompt: string };
}

async function runAttempt(args: RunAttemptArgs): Promise<RunAttemptResult> {
  return new Promise((resolve) => {
    let settled = false;
    let shouldRotate = false;
    let mediumSignalSeen = false;
    let sessionId: string | undefined;
    let retryAfterMs: number | undefined;
    const spawnOptions: SpawnOptions = {
      env: buildCodexEnv(args.account, args.env)
    };
    if (args.cwd) {
      spawnOptions.cwd = args.cwd;
    }
    const handle = args.adapter.spawn('codex', buildCodexArgs(args.account, args.codexArgs, args.resume), spawnOptions);

    handle.onData((chunk) => {
      args.output(chunk);
      sessionId = extractSessionId(chunk) ?? sessionId;
      const match = detectOutput(chunk, args.customQuotaPatterns);
      retryAfterMs = match.retryAfterMs ?? retryAfterMs;
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
      const failed = exit.exitCode !== 0 && exit.exitCode !== null;
      resolve({
        exitCode: exit.exitCode,
        signal: exit.signal,
        shouldRotate: shouldRotate || (mediumSignalSeen && failed),
        ...(sessionId ? { sessionId } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
      });
    });
  });
}

export function createDefaultProcessAdapter(): ProcessAdapter {
  try {
    return new PtyProcessAdapter();
  } catch {
    return new NodeProcessAdapter();
  }
}

class PtyProcessAdapter implements ProcessAdapter {
  private readonly ptyModule: typeof import('node-pty');

  constructor() {
    this.ptyModule = requireNodePty();
  }

  spawn(command: string, args: string[], options: SpawnOptions): ProcessHandle {
    const terminal = this.ptyModule.spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env
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

  write(data: string): void {
    this.terminal.write(data);
  }

  kill(): void {
    this.terminal.kill();
  }
}

function requireNodePty(): typeof import('node-pty') {
  const require = createRequire(import.meta.url);
  return require('node-pty') as typeof import('node-pty');
}

class NodeProcessAdapter implements ProcessAdapter {
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

  write(data: string): void {
    this.child.stdin?.write(data);
  }

  kill(): void {
    this.child.kill();
  }
}
