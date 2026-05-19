import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAccount } from '../src/core/accounts.js';
import { loadHealthFile, recordAccountFailure } from '../src/core/health.js';
import { markRetryAvailability } from '../src/core/state.js';
import {
  buildCodexArgs,
  buildCodexEnv,
  createDefaultProcessAdapter,
  runManagedCodex,
  type ProcessAdapter,
  type ProcessHandle
} from '../src/core/runner.js';
import type { RelayAccount } from '../src/types.js';

const tmpDir = fileURLToPath(new URL('./tmp-runner/', import.meta.url));
const accountsPath = join(tmpDir, 'accounts.json');
const statePath = join(tmpDir, 'state.json');
const healthPath = join(tmpDir, 'health.json');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('runner', () => {
  const account: RelayAccount = {
    name: 'relay-a',
    apiKey: 'sk-a',
    baseUrl: 'https://relay.example.com/v1',
    model: 'gpt-5.1-codex',
    addedAt: '2026-05-18T00:00:00.000Z'
  };

  it('builds codex env without overriding CODEX_HOME', () => {
    const env = buildCodexEnv(account, { CODEX_HOME: '/keep', FOO: 'bar' });

    expect(env.OPENAI_API_KEY).toBe('sk-a');
    expect(env.CODEX_HOME).toBe('/keep');
    expect(env.FOO).toBe('bar');
  });

  it('builds codex args with base url config and model', () => {
    const args = buildCodexArgs(account, ['hello']);

    expect(args).toEqual([
      '-c',
      'openai_base_url="https://relay.example.com/v1"',
      '-m',
      'gpt-5.1-codex',
      'hello',
      '--no-alt-screen'
    ]);
  });

  it('does not add no-alt-screen to non-interactive exec mode', () => {
    const args = buildCodexArgs(account, ['exec', 'hello']);

    expect(args).toEqual([
      '-c',
      'openai_base_url="https://relay.example.com/v1"',
      '-m',
      'gpt-5.1-codex',
      'exec',
      'hello'
    ]);
  });

  it('adds no-alt-screen when resuming an interactive session after rotation', () => {
    const args = buildCodexArgs(account, ['hello'], {
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      prompt: 'Continue'
    });

    expect(args).toEqual([
      '-c',
      'openai_base_url="https://relay.example.com/v1"',
      '-m',
      'gpt-5.1-codex',
      'resume',
      '--no-alt-screen',
      '123e4567-e89b-12d3-a456-426614174000',
      'Continue'
    ]);
  });

  it('does not duplicate no-alt-screen when the user already passed it', () => {
    const args = buildCodexArgs(account, ['--no-alt-screen', 'hello']);

    expect(args.filter((arg) => arg === '--no-alt-screen')).toHaveLength(1);
  });

  it('detects non-interactive subcommands after codex options with values', () => {
    const args = buildCodexArgs(account, ['--model', 'gpt-5.2', 'exec', 'hello']);

    expect(args).not.toContain('--no-alt-screen');
  });

  it('keeps exec resume mode after codex options with values', () => {
    const args = buildCodexArgs(account, ['--model', 'gpt-5.2', 'exec', 'hello'], {
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      prompt: 'Continue'
    });

    expect(args).toEqual([
      '-c',
      'openai_base_url="https://relay.example.com/v1"',
      '-m',
      'gpt-5.1-codex',
      'exec',
      'resume',
      '123e4567-e89b-12d3-a456-426614174000',
      'Continue'
    ]);
  });

  it('treats arguments after -- as positional codex input', () => {
    const args = buildCodexArgs(account, ['--', 'exec']);

    expect(args).toContain('--no-alt-screen');
  });

  it('creates a default process adapter', () => {
    expect(createDefaultProcessAdapter()).toHaveProperty('spawn');
  });

  it('falls back to the node process adapter when pty loading fails', () => {
    const adapter = createDefaultProcessAdapter(() => {
      throw new Error('pty missing');
    });

    expect(adapter).toHaveProperty('spawn');
  });

  it('uses the pty adapter when loading succeeds', () => {
    const spawned: Array<{ command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }> = [];
    const writes: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    const fakePtyModule = {
      spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
        spawned.push({ command, args, options });
        return {
          onData: () => undefined,
          onExit: () => undefined,
          kill: () => undefined,
          write: (chunk: string) => writes.push(chunk),
          resize: (cols: number, rows: number) => resizes.push({ cols, rows })
        };
      }
    };
    const adapter = createDefaultProcessAdapter(() => fakePtyModule as unknown as typeof import('node-pty'));

    const handle = adapter.spawn('codex', ['hello'], {
      env: { FOO: 'bar' },
      cwd: '/tmp/project'
    });
    handle.onData(() => undefined);
    handle.onExit(() => undefined);
    handle.write?.('input');
    handle.resize?.(101, 33);
    handle.kill();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe('codex');
    expect(spawned[0]?.args).toEqual(['hello']);
    expect(spawned[0]?.options).toMatchObject({
      cwd: '/tmp/project',
      env: { FOO: 'bar' }
    });
    expect(writes).toEqual(['input']);
    expect(resizes).toEqual([{ cols: 101, rows: 33 }]);
  });

  it('runs through the node process adapter fallback', async () => {
    const adapter = createDefaultProcessAdapter(() => {
      throw new Error('pty missing');
    });
    const data: string[] = [];
    const handle = adapter.spawn(
      process.execPath,
      ['-e', 'console.log("node-ok"); console.error("node-err")'],
      { env: process.env }
    );

    const exit = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      handle.onData((chunk) => data.push(chunk));
      handle.onExit(resolve);
    });

    expect(exit.exitCode).toBe(0);
    expect(data.join('')).toContain('node-ok');
    expect(data.join('')).toContain('node-err');
  });

  it('rejects interactive TUI runs when node-pty is unavailable', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    const adapter = createDefaultProcessAdapter(() => {
      throw new Error('pty missing');
    });

    await expect(
      runManagedCodex(
        { codexArgs: ['do task'] },
        {
          paths: { accounts: accountsPath, state: statePath },
          adapter,
          output: () => undefined
        }
      )
    ).rejects.toThrow(/requires node-pty/i);
  });

  it('forwards parent input to the node process adapter child stdin', async () => {
    const adapter = createDefaultProcessAdapter(() => {
      throw new Error('pty missing');
    });
    const handle = adapter.spawn(
      process.execPath,
      ['-e', 'process.stdin.once("data", (chunk) => { process.stdout.write("stdin:" + chunk.toString()); process.exit(0) })'],
      { env: process.env }
    );
    const data: string[] = [];

    const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      handle.onData((chunk) => data.push(chunk));
      handle.onExit(resolve);
    });
    handle.write?.('yes\n');

    const exit = await exitPromise;
    expect(exit.exitCode).toBe(0);
    expect(data.join('')).toBe('stdin:yes\n');
  });

  it('kills the node process adapter child process', async () => {
    const adapter = createDefaultProcessAdapter(() => {
      throw new Error('pty missing');
    });
    const handle = adapter.spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 10000)'], {
      env: process.env
    });

    const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      handle.onExit(resolve);
    });
    handle.kill();

    await expect(exitPromise).resolves.toBeDefined();
  });

  it('rotates on high-confidence quota output and resumes the same session', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\n`, 'Error: insufficient balance\n'],
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      {
        codexArgs: ['do task'],
        accountName: 'relay-a'
      },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-a');
    expect(adapter.spawns[1]?.env.OPENAI_API_KEY).toBe('sk-b');
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[1]?.args).toContain('Continue');
  });

  it('falls back to resume --last when no session id is detected', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const adapter = new FakeAdapter([
      ['Error: insufficient balance\n'],
      ['continued\n']
    ]);

    await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain('--last');
    expect(adapter.spawns[1]?.args).toContain('Continue');
  });

  it('keeps non-interactive exec mode when resuming after rotation', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\n`, 'HTTP 401 invalid api key\n'],
      ['continued\n']
    ]);

    await runManagedCodex(
      { codexArgs: ['exec', '--skip-git-repo-check', 'do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(adapter.spawns[1]?.args).toEqual([
      '-c',
      'openai_base_url="https://b.example.com/v1"',
      'exec',
      'resume',
      sessionId,
      'Continue'
    ]);
  });

  it('skips accounts whose retry time is still in the future', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });
    await markRetryAvailability(statePath, 'relay-a', {
      displayText: 'future',
      availableAt: '2099-01-01T00:00:00.000Z'
    });

    const adapter = new FakeAdapter([['ok\n']]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-19T00:00:00.000Z')
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-b');
  });

  it('rotates across multiple keys under the same relay base url', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a-1',
      apiKey: 'sk-bad-1',
      baseUrl: 'https://same-relay.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-a-2',
      apiKey: 'sk-bad-2',
      baseUrl: 'https://same-relay.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-a-3',
      apiKey: 'sk-good-3',
      baseUrl: 'https://same-relay.example.com/v1'
    });

    const adapter = new FakeAdapter([
      ['HTTP 401 invalid api key\n'],
      ['insufficient balance\n'],
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a-1' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(result.usedAccount).toBe('relay-a-3');
    expect(adapter.spawns.map((spawn) => spawn.env.OPENAI_API_KEY)).toEqual([
      'sk-bad-1',
      'sk-bad-2',
      'sk-good-3'
    ]);
    expect(new Set(adapter.spawns.map((spawn) => spawn.args[1]))).toEqual(
      new Set(['openai_base_url="https://same-relay.example.com/v1"'])
    );
  });

  it('does not rotate on medium-confidence output when the process exits successfully', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const adapter = new FakeAdapter([['rate limit noted, but recovered\n']]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(result.usedAccount).toBe('relay-a');
    expect(adapter.spawns).toHaveLength(1);
  });

  it('rotates on medium-confidence output when the process exits unsuccessfully', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const adapter = new FakeAdapter([
      {
        chunks: ['too many requests\n'],
        exitCode: 1
      },
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
  });

  it('records retry windows from detector output', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const adapter = new FakeAdapter([
      ['insufficient balance retry after 30s\n'],
      ['continued\n']
    ]);

    await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-19T00:00:00.000Z')
      }
    );

    const { loadStateFile } = await import('../src/core/state.js');
    const state = await loadStateFile(statePath);
    expect(state.retryAvailability['relay-a']?.availableAt).toBe('2026-05-19T00:00:30.000Z');
    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      status: 'cooldown',
      reason: 'quota',
      cooldownUntil: '2026-05-19T00:00:30.000Z',
      consecutiveFailures: 1
    });
  });

  it('skips accounts cooling down in health state', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    const adapter = new FakeAdapter([['ok\n']]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, health: healthPath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-19T01:00:00.000Z')
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-b');
  });

  it('marks a successful account as active in health state', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'server',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, health: healthPath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-19T00:02:00.000Z')
      }
    );

    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      status: 'active',
      consecutiveFailures: 0,
      lastSuccessAt: '2026-05-19T00:02:00.000Z'
    });
  });

  it('retires accounts that have failed continuously for ten days before running', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'auth',
      now: new Date('2026-05-10T00:00:00.000Z')
    });

    const adapter = new FakeAdapter([['ok\n']]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, health: healthPath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-20T00:00:01.000Z')
      }
    );

    const { loadAccountsFile } = await import('../src/core/accounts.js');
    const accountsFile = await loadAccountsFile(accountsPath);
    const health = await loadHealthFile(healthPath);
    expect(result.usedAccount).toBe('relay-b');
    expect(accountsFile.accounts.map((account) => account.name)).toEqual(['relay-b']);
    expect(health.retired.map((account) => account.name)).toEqual(['relay-a']);
  });

  it('fails clearly when every account is exhausted', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const adapter = new FakeAdapter([
      ['insufficient balance\n'],
      ['HTTP 401 invalid api key\n']
    ]);

    await expect(
      runManagedCodex(
        { codexArgs: ['do task'], accountName: 'relay-a' },
        {
          paths: { accounts: accountsPath, state: statePath },
          adapter,
          output: () => undefined
        }
      )
    ).rejects.toThrow(/all relay accounts/i);
  });

  it('passes cwd to the spawned codex process', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'], cwd: '/workspace/project' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(adapter.spawns[0]?.cwd).toBe('/workspace/project');
  });

  it('restores parent stdin raw mode after an interactive attempt exits', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const input = new FakeInput();
    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        input: input as unknown as NodeJS.ReadStream,
        output: () => undefined,
        outputStream: new FakeOutputStream() as unknown as NodeJS.WriteStream
      }
    );

    expect(input.rawModes).toEqual([true, false]);
    expect(input.pauseCount).toBe(1);
  });

  it('resizes the pty handle when the parent terminal is resized', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const adapter = new FakeAdapter([{ chunks: [], exitCode: 0, autoExit: false }]);
    const outputStream = new FakeOutputStream();
    const run = runManagedCodex(
      { codexArgs: ['do task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined,
        outputStream: outputStream as unknown as NodeJS.WriteStream
      }
    );
    const handle = await adapter.waitForHandle();

    outputStream.columns = 120;
    outputStream.rows = 40;
    outputStream.emit('resize');
    handle.exit();

    await run;
    expect(handle.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('preserves an existing parent stdin raw mode', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const input = new FakeInput();
    input.isRaw = true;
    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        input: input as unknown as NodeJS.ReadStream,
        output: () => undefined,
        outputStream: new FakeOutputStream() as unknown as NodeJS.WriteStream
      }
    );

    expect(input.rawModes).toEqual([true, true]);
    expect(input.pauseCount).toBe(0);
  });

  it('passes the current terminal size to the pty adapter', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const adapter = new FakeAdapter([['ok\n']]);
    const outputStream = new FakeOutputStream();
    outputStream.columns = 132;
    outputStream.rows = 43;

    await runManagedCodex(
      { codexArgs: ['do task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined,
        outputStream: outputStream as unknown as NodeJS.WriteStream
      }
    );

    expect(adapter.spawns[0]).toMatchObject({ cols: 132, rows: 43 });
  });
});

type FakeScript = string[] | { chunks: string[]; exitCode: number; autoExit?: boolean };

class FakeAdapter implements ProcessAdapter {
  public readonly supportsInteractiveTui = true;
  public spawns: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
    cols?: number;
    rows?: number;
  }> = [];
  public handles: FakeHandle[] = [];
  private waiters: Array<(handle: FakeHandle) => void> = [];
  private readonly scripts: FakeScript[];

  constructor(scripts: FakeScript[]) {
    this.scripts = scripts;
  }

  spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; cols?: number; rows?: number }): ProcessHandle {
    this.spawns.push({ command, args, env: options.env, cwd: options.cwd, cols: options.cols, rows: options.rows });
    const script = this.scripts.shift() ?? [];
    const handle = Array.isArray(script)
      ? new FakeHandle(script, 0)
      : new FakeHandle(script.chunks, script.exitCode, script.autoExit ?? true);
    this.handles.push(handle);
    this.waiters.shift()?.(handle);
    handle.start();
    return handle;
  }

  async waitForHandle(): Promise<FakeHandle> {
    const handle = this.handles[0];
    if (handle) {
      return handle;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class FakeHandle extends EventEmitter implements ProcessHandle {
  public killed = false;
  public resizes: Array<{ cols: number; rows: number }> = [];

  constructor(
    private readonly chunks: string[],
    private readonly exitCode: number,
    private readonly autoExit = true
  ) {
    super();
  }

  start(): void {
    queueMicrotask(() => {
      for (const chunk of this.chunks) {
        this.emit('data', chunk);
        if (this.killed) {
          return;
        }
      }
      if (this.autoExit) {
        this.exit();
      }
    });
  }

  onData(callback: (chunk: string) => void): void {
    this.on('data', callback);
  }

  onExit(callback: (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.on('exit', callback);
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', { exitCode: 1, signal: null });
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  exit(): void {
    this.emit('exit', { exitCode: this.exitCode, signal: null });
  }
}

class FakeInput extends EventEmitter {
  public isTTY = true;
  public isRaw = false;
  public rawModes: boolean[] = [];
  public pauseCount = 0;

  setRawMode(value: boolean): void {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume(): this {
    return this;
  }

  pause(): this {
    this.pauseCount += 1;
    return this;
  }
}

class FakeOutputStream extends EventEmitter {
  public isTTY = true;
  public columns = 80;
  public rows = 24;
  public writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}
