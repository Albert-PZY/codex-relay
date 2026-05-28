import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { RelayAccount } from '../types.js';

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

export type ResumeRequest = {
  sessionId: string;
  prompt: string;
};

type NodePtyModule = typeof import('node-pty');
type NodePtyLoader = () => NodePtyModule;

export const nonInteractiveSubcommands = new Set([
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

export const codexOptionsWithValue = new Set([
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

export function isNonInteractiveCodexInvocation(codexArgs: string[]): boolean {
  const firstPositional = findFirstPositionalArg(codexArgs);
  return firstPositional !== undefined && nonInteractiveSubcommands.has(firstPositional);
}

export function isExecCodexInvocation(codexArgs: string[]): boolean {
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
