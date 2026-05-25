import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAccount, loadAccountsFile, setPreferredAccount } from '../src/core/accounts.js';
import { loadHealthFile, recordAccountFailure } from '../src/core/health.js';
import { loadStateFile, saveStateFile } from '../src/core/state.js';
import {
  buildCodexArgs,
  buildCodexEnv,
  createDefaultProcessAdapter,
  resolveCodexSpawnTarget,
  runManagedCodex,
  type ProcessAdapter,
  type ProcessHandle
} from '../src/core/runner.js';
import type { RelayAccount } from '../src/types.js';

const tmpRoot = fileURLToPath(new URL('./tmp-runner/', import.meta.url));
let tmpDir = '';
let accountsPath = '';
let statePath = '';
let healthPath = '';
let rotationLogPath = '';

beforeEach(() => {
  tmpDir = join(tmpRoot, randomTestDirName());
  accountsPath = join(tmpDir, 'accounts.json');
  statePath = join(tmpDir, 'state.json');
  healthPath = join(tmpDir, 'health.json');
  rotationLogPath = join(tmpDir, 'rotation.log');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('runner', () => {
  const account: RelayAccount = {
    name: 'relay-a',
    apiKey: 'sk-a',
    baseUrl: 'https://relay.example.com/v1',
    model: 'gpt-5.1-codex',
    addedAt: '2026-05-18T00:00:00.000Z'
  };

  it('builds codex env with the configured CODEX_HOME when provided', () => {
    const env = buildCodexEnv(account, { CODEX_HOME: '/keep', FOO: 'bar' });

    expect(env.OPENAI_API_KEY).toBe('sk-a');
    expect(env.CODEX_HOME).toBe('/keep');
    expect(env.FOO).toBe('bar');

    const configuredEnv = buildCodexEnv(account, { CODEX_HOME: '/user-codex' }, '/relay-codex');
    expect(configuredEnv.OPENAI_API_KEY).toBe('sk-a');
    expect(configuredEnv.CODEX_HOME).toBe('/relay-codex');
  });

  it('builds codex args with model and no base url override', () => {
    const args = buildCodexArgs(account, ['hello']);

    expect(args).toEqual([
      '-m',
      'gpt-5.1-codex',
      'hello',
      '--no-alt-screen'
    ]);
  });

  it('does not add no-alt-screen to non-interactive exec mode', () => {
    const args = buildCodexArgs(account, ['exec', 'hello']);

    expect(args).toEqual([
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
      '-m',
      'gpt-5.1-codex',
      '--no-alt-screen',
      'resume',
      '123e4567-e89b-12d3-a456-426614174000',
      'Continue'
    ]);
  });

  it('always binds resume args to an explicit session id', () => {
    const args = buildCodexArgs(account, ['hello'], {
      sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
      prompt: 'Continue'
    });

    expect(args).toContain('resume');
    expect(args).toContain('019e365c-a287-74a3-890e-5b23a633f3c1');
    expect(args).not.toContain('--last');
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

  it('resolves the npm codex shim before stale Windows executables', async () => {
    const binDir = join(tmpDir, 'bin');
    const scriptPath = join(binDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const staleDir = join(tmpDir, 'stale');
    await mkdir(join(binDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(binDir, 'codex.cmd'), '@echo off\r\n');
    await writeFile(scriptPath, 'console.log("new codex")\n');
    await writeFile(join(staleDir, 'codex.exe'), '');

    const target = resolveCodexSpawnTarget(
      { Path: `${binDir};${staleDir}` },
      'win32'
    );

    expect(target).toEqual({
      command: process.execPath,
      argsPrefix: [scriptPath]
    });
  });

  it('uses an explicit codex path when CODEX_RELAY_CODEX_PATH is set', () => {
    const target = resolveCodexSpawnTarget(
      { CODEX_RELAY_CODEX_PATH: 'C:\\Tools\\codex.exe' },
      'win32'
    );

    expect(target).toEqual({
      command: 'C:\\Tools\\codex.exe',
      argsPrefix: []
    });
  });

  it('falls back cleanly when no Windows codex path is found', () => {
    expect(resolveCodexSpawnTarget({}, 'win32')).toEqual({
      command: 'codex',
      argsPrefix: []
    });
    expect(resolveCodexSpawnTarget({ PATH: ' ; "C:\\Missing" ; ' }, 'win32')).toEqual({
      command: 'codex',
      argsPrefix: []
    });
    expect(resolveCodexSpawnTarget({ PATH: '/usr/local/bin' }, 'linux')).toEqual({
      command: 'codex',
      argsPrefix: []
    });
  });

  it('resolves Windows codex.cmd shims without npm scripts through the shell', async () => {
    const binDir = join(tmpDir, 'cmd-only');
    const cmdPath = join(binDir, 'codex.cmd');
    await mkdir(binDir, { recursive: true });
    await writeFile(cmdPath, '@echo off\r\n');

    expect(resolveCodexSpawnTarget({ PATH: binDir }, 'win32')).toEqual({
      command: cmdPath,
      argsPrefix: [],
      shell: true
    });
    expect(resolveCodexSpawnTarget({ CODEX_RELAY_CODEX_PATH: cmdPath }, 'win32')).toEqual({
      command: cmdPath,
      argsPrefix: [],
      shell: true
    });
  });

  it('falls back to Windows codex.exe when no npm shim is present', async () => {
    const binDir = join(tmpDir, 'exe-only');
    const exePath = join(binDir, 'codex.exe');
    await mkdir(binDir, { recursive: true });
    await writeFile(exePath, '');

    expect(resolveCodexSpawnTarget({ Path: binDir }, 'win32')).toEqual({
      command: exePath,
      argsPrefix: []
    });
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

  it('launches the resolved npm codex script from the pty adapter on Windows', async () => {
    const binDir = join(tmpDir, 'pty-bin');
    const scriptPath = join(binDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await mkdir(join(binDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    await writeFile(join(binDir, 'codex.cmd'), '@echo off\r\n');
    await writeFile(scriptPath, 'console.log("new codex")\n');

    const spawned: Array<{ command: string; args: string[] }> = [];
    const fakePtyModule = {
      spawn(command: string, args: string[]) {
        spawned.push({ command, args });
        return {
          onData: () => undefined,
          onExit: () => undefined,
          kill: () => undefined,
          write: () => undefined,
          resize: () => undefined
        };
      }
    };
    const adapter = createDefaultProcessAdapter(() => fakePtyModule as unknown as typeof import('node-pty'));

    adapter.spawn('codex', ['--version'], {
      env: { Path: binDir }
    });

    const expected =
      process.platform === 'win32'
        ? { command: process.execPath, args: [scriptPath, '--version'] }
        : { command: 'codex', args: ['--version'] };
    expect(spawned).toEqual([expected]);
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

  it('launches an explicit codex command from the node process adapter', async () => {
    const adapter = createDefaultProcessAdapter(() => {
      throw new Error('pty missing');
    });
    const data: string[] = [];
    const handle = adapter.spawn('codex', ['--version'], {
      env: { ...process.env, CODEX_RELAY_CODEX_PATH: process.execPath }
    });

    const exit = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      handle.onData((chunk) => data.push(chunk));
      handle.onExit(resolve);
    });

    expect(exit.exitCode).toBe(0);
    expect(data.join('')).toContain(process.version);
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

  it('prints the active relay account inside resumed codex output after rotation', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-1234567890abcdef',
      baseUrl: 'https://b.example.com/v1',
      model: 'gpt-5.2'
    });

    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const output: string[] = [];
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\n`, 'Error: insufficient balance\n'],
      ['continued\n']
    ]);

    await runManagedCodex(
      {
        codexArgs: ['do task'],
        accountName: 'relay-a'
      },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: (chunk) => output.push(chunk)
      }
    );

    const text = output.join('');
    expect(text).toContain('continued\n');
    expect(text).toContain('[codex-relay] active relay account: relay-b');
    expect(text).toContain('key sk-...cdef');
    expect(text).toContain('baseUrl https://b.example.com/v1');
    expect(text).toContain('model gpt-5.2');
    expect(text).not.toContain('sk-1234567890abcdef');
  });

  it('rotates on relay-disabled API key output and resumes a UUID v7 session from buffered chunks', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://right.codes/codex/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });
    await setPreferredAccount(accountsPath, 'relay-a');

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const output: string[] = [];
    const adapter = new FakeAdapter([
      [
        `Context 5% used  ${sessionId}\n`,
        'unexpected status 403 ',
        'Forbidden: {"error":"API Key 已被禁用"}, url: https://right.codes/codex/v1/responses\n'
      ],
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      {
        codexArgs: ['do task'],
        accountName: 'relay-a'
      },
      {
        paths: { accounts: accountsPath, state: statePath, rotationLog: rotationLogPath },
        adapter,
        output: (chunk) => output.push(chunk)
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-a');
    expect(adapter.spawns[1]?.env.OPENAI_API_KEY).toBe('sk-b');
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[1]?.args).toContain('Continue');
    expect(output.join('')).toContain('[codex-relay] relay-a failed (auth); switching to relay-b');

    const log = await readFile(rotationLogPath, 'utf8');
    const rotation = JSON.parse(log.trim()) as { fromAccount: string; toAccount: string; reason: string; resumeMode: string; sessionId: string };
    expect(rotation).toMatchObject({
      fromAccount: 'relay-a',
      toAccount: 'relay-b',
      reason: 'auth',
      resumeMode: 'session',
      sessionId
    });

    const state = await loadStateFile(statePath);
    expect(state.currentIndex).toBe(1);
    expect(state.lastSuccessfulAccount).toBe('relay-b');
    expect((await loadAccountsFile(accountsPath)).preferred).toBe('relay-b');
  });

  it('continues rotation even when the killed TUI does not emit an exit event', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://right.codes/codex/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      {
        chunks: [
          `Context 5% used  ${sessionId}\n`,
          'Unexpected status 403 Forbidden: {"error":"API Key 已被禁用"}\n'
        ],
        exitCode: 1,
        autoExit: false,
        emitExitOnKill: false
      },
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
    expect(adapter.handles[0]?.killed).toBe(true);
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
  });

  it('rotates on conversation interruption text only when a session id is bound', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://right.codes/codex/v1'
    });
    await addAccount(accountsPath, {
      name: 'relay-b',
      apiKey: 'sk-b',
      baseUrl: 'https://b.example.com/v1'
    });

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      [
        `Context 4% used  ${sessionId}\n`,
        `Conversation interrupted - tell the model what to do differently.\n`,
        `Unexpected status 403 Forbidden: {"error":"API Key 已被禁用"}\n`
      ],
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], cwd: '/workspace/project', accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[1]?.args).toContain('Continue');
    expect((await loadStateFile(statePath)).pendingResume).toBeUndefined();
  });

  it('shows the current relay account with a masked key before launching codex', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-1234567890abcdef',
      baseUrl: 'https://a.example.com/v1',
      model: 'gpt-5.2'
    });

    const output: string[] = [];
    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: (chunk) => output.push(chunk)
      }
    );

    const text = output.join('');
    expect(text).toContain('[codex-relay] using relay-a');
    expect(text).toContain('key sk-...cdef');
    expect(text).toContain('baseUrl https://a.example.com/v1');
    expect(text).toContain('model gpt-5.2');
    expect(text).not.toContain('sk-1234567890abcdef');
  });

  it('stops rotation when no bound session id can be detected', async () => {
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

    const output: string[] = [];
    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, health: healthPath },
        adapter,
        output: (chunk) => output.push(chunk)
      }
    );

    expect(result.usedAccount).toBe('relay-a');
    expect(result.exitCode).toBe(1);
    expect(adapter.spawns).toHaveLength(1);
    expect(output.join('')).toContain('Unable to safely resume');
    const health = await loadHealthFile(healthPath);
    expect(health.accounts['relay-a']).toMatchObject({
      status: 'cooldown',
      reason: 'quota'
    });
  });

  it('discovers the bound session from Codex session files before rotating', async () => {
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

    const cwd = '/workspace/project';
    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      { chunks: [], exitCode: 1, autoExit: false },
      ['continued\n']
    ]);

    const run = runManagedCodex(
      { codexArgs: ['do task'], cwd, accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );
    const firstHandle = await adapter.waitForHandle();
    const runCodexHome = String(adapter.spawns[0]?.env.CODEX_HOME);
    const sessionDir = join(runCodexHome, 'sessions', '2026', '05', '24');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd,
          timestamp: new Date().toISOString()
        }
      })}\n`,
      'utf8'
    );
    firstHandle.emit('data', 'Error: insufficient balance\n');

    const result = await run;
    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[1]?.args).toContain('Continue');
  });

  it('discovers the bound session from Codex history before rotating', async () => {
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

    const cwd = '/workspace/project';
    const codexHome = join(tmpDir, 'history-codex-home');
    const sessionId = '019d7bcd-15ef-7921-a22d-4552303fee6c';
    const adapter = new FakeAdapter([
      { chunks: [], exitCode: 1, autoExit: false },
      ['continued\n']
    ]);

    const run = runManagedCodex(
      { codexArgs: ['do task'], cwd, accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, codexHome },
        adapter,
        output: () => undefined
      }
    );
    const firstHandle = await adapter.waitForHandle();
    await writeFile(
      join(codexHome, 'history.jsonl'),
      `${JSON.stringify({
        session_id: sessionId,
        ts: Math.floor(Date.now() / 1000),
        text: 'hello'
      })}\n`,
      'utf8'
    );
    firstHandle.emit('data', 'Unexpected status 402 Payment Required\n');

    const result = await run;
    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[1]?.args).toContain('Continue');
  });

  it('discovers an updated existing session id from Codex history before rotating', async () => {
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

    const cwd = '/workspace/project';
    const codexHome = join(tmpDir, 'existing-history-codex-home');
    const sessionId = '019d7bcd-15ef-7921-a22d-4552303fee6c';
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'history.jsonl'),
      `${JSON.stringify({
        session_id: sessionId,
        ts: Math.floor((Date.now() - 60_000) / 1000),
        text: 'old prompt'
      })}\n`,
      'utf8'
    );

    const adapter = new FakeAdapter([
      { chunks: [], exitCode: 1, autoExit: false },
      ['continued\n']
    ]);

    const run = runManagedCodex(
      { codexArgs: ['do task'], cwd, accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, codexHome },
        adapter,
        output: () => undefined
      }
    );
    const firstHandle = await adapter.waitForHandle();
    await writeFile(
      join(codexHome, 'history.jsonl'),
      `${JSON.stringify({
        session_id: sessionId,
        ts: Math.floor((Date.now() - 60_000) / 1000),
        text: 'old prompt'
      })}\n${JSON.stringify({
        session_id: sessionId,
        ts: Math.floor(Date.now() / 1000),
        text: 'hello'
      })}\n`,
      'utf8'
    );
    firstHandle.emit('data', 'Unexpected status 402 Payment Required\n');

    const result = await run;
    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[1]?.args).toContain('Continue');
  });

  it('automatically resumes a pending interrupted session on the next empty launch', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const cwd = '/workspace/project';
    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    await saveStateFile(statePath, {
      version: 1,
      currentIndex: 0,
      leases: {},
      pendingResume: {
        sessionId,
        prompt: 'Continue',
        cwd,
        updatedAt: '2026-05-23T00:00:00.000Z'
      },
      updatedAt: '2026-05-23T00:00:00.000Z'
    });

    const adapter = new FakeAdapter([['continued\n']]);

    await runManagedCodex(
      { codexArgs: [], cwd },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined
      }
    );

    expect(adapter.spawns).toHaveLength(1);
    expect(adapter.spawns[0]?.args).toContain('resume');
    expect(adapter.spawns[0]?.args).toContain(sessionId);
    expect(adapter.spawns[0]?.args).toContain('Continue');
    expect((await loadStateFile(statePath)).pendingResume).toBeUndefined();
  });

  it('rotates on payload tier limit errors and shows the switch in output', async () => {
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

    const output: string[] = [];
    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      [`Context 5% used ${sessionId}\nunexpected status 413 Payload Too Large: Request body exceeds your tier limit (3MB for tier 0)\n`],
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, health: healthPath, codexHome: join(tmpDir, 'configured-codex') },
        adapter,
        env: { CODEX_HOME: '/user-codex' },
        output: (chunk) => output.push(chunk)
      }
    );

    expect(result.usedAccount).toBe('relay-b');
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-a');
    expect(adapter.spawns[1]?.env.OPENAI_API_KEY).toBe('sk-b');
    const codexHome = String(adapter.spawns[0]?.env.CODEX_HOME);
    expect(codexHome).toContain(join(tmpDir, 'instances'));
    expect(adapter.spawns[1]?.env.CODEX_HOME).toBe(codexHome);
    expect(adapter.spawns[1]?.args).toContain('resume');
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(output.join('')).toContain('[codex-relay] relay-a failed (quota); switching to relay-b');
    expect(output.join('')).toContain('[codex-relay] resuming with relay-b');
  });

  it('writes a concise rotation log when switching accounts', async () => {
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

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\nHTTP 401 invalid api key\n`],
      ['continued\n']
    ]);

    await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, rotationLog: rotationLogPath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-21T00:00:00.000Z')
      }
    );

    const log = await readFile(rotationLogPath, 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      timestamp: '2026-05-21T00:00:00.000Z',
      event: 'account_rotation',
      fromAccount: 'relay-a',
      toAccount: 'relay-b',
      reason: 'auth',
      resumeMode: 'session',
      sessionId
    });
  });

  it('creates a run-scoped codex home from the configured source home before launching codex', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const codexHome = join(tmpDir, 'missing-codex-home');
    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, codexHome },
        adapter,
        output: () => undefined
      }
    );

    const runCodexHome = String(adapter.spawns[0]?.env.CODEX_HOME);
    expect(runCodexHome).toContain(join(tmpDir, 'instances'));
    await expect(readFile(join(codexHome, 'session_index.jsonl'), 'utf8')).resolves.toBe('');
    expect((await stat(join(codexHome, 'sessions'))).isDirectory()).toBe(true);
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
      'exec',
      'resume',
      sessionId,
      'Continue'
    ]);
  });

  it('leases different accounts across concurrent managed runs', async () => {
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

    const firstAdapter = new FakeAdapter([{ chunks: [], exitCode: 0, autoExit: false }]);
    const secondAdapter = new FakeAdapter([{ chunks: ['ok\n'], exitCode: 0 }]);
    const firstRun = runManagedCodex(
      { codexArgs: ['first task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter: firstAdapter,
        output: () => undefined
      }
    );
    const firstHandle = await firstAdapter.waitForHandle();

    await runManagedCodex(
      { codexArgs: ['second task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter: secondAdapter,
        output: () => undefined
      }
    );

    expect(firstAdapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-a');
    expect(secondAdapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-b');
    expect(firstAdapter.spawns[0]?.env.CODEX_HOME).not.toBe(secondAdapter.spawns[0]?.env.CODEX_HOME);
    expect(String(firstAdapter.spawns[0]?.env.CODEX_HOME)).toContain(join(tmpDir, 'instances'));
    expect(String(secondAdapter.spawns[0]?.env.CODEX_HOME)).toContain(join(tmpDir, 'instances'));
    expect(Object.values((await loadStateFile(statePath)).leases)).toHaveLength(1);

    firstHandle.exit();
    await firstRun;
    expect(Object.values((await loadStateFile(statePath)).leases)).toHaveLength(0);
  });

  it('shares an account only when every available account is already leased', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    const firstAdapter = new FakeAdapter([{ chunks: [], exitCode: 0, autoExit: false }]);
    const secondAdapter = new FakeAdapter([{ chunks: ['ok\n'], exitCode: 0 }]);
    const output: string[] = [];
    const firstRun = runManagedCodex(
      { codexArgs: ['first task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter: firstAdapter,
        output: () => undefined
      }
    );
    const firstHandle = await firstAdapter.waitForHandle();

    await runManagedCodex(
      { codexArgs: ['second task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter: secondAdapter,
        output: (chunk) => output.push(chunk)
      }
    );

    expect(secondAdapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-a');
    expect(output.join('')).toContain('already in use in another terminal');

    firstHandle.exit();
    await firstRun;
  });

  it('ignores expired leases when choosing an account', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: 0,
        leases: {
          expired: {
            accountName: 'relay-a',
            ownerId: 'expired',
            pid: 1,
            startedAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
            expiresAt: '2026-05-19T00:01:00.000Z'
          }
        },
        updatedAt: '2026-05-19T00:00:00.000Z'
      }),
      'utf8'
    );

    const adapter = new FakeAdapter([['ok\n']]);

    await runManagedCodex(
      { codexArgs: ['do task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-19T00:02:00.000Z')
      }
    );

    expect(adapter.spawns[0]?.env.OPENAI_API_KEY).toBe('sk-a');
    expect((await loadStateFile(statePath)).leases).toEqual({});
  });

  it('refreshes the active account lease while codex is running', async () => {
    await addAccount(accountsPath, {
      name: 'relay-a',
      apiKey: 'sk-a',
      baseUrl: 'https://a.example.com/v1'
    });

    let currentTime = new Date('2026-05-19T00:00:00.000Z');
    const adapter = new FakeAdapter([{ chunks: [], exitCode: 0, autoExit: false }]);
    const run = runManagedCodex(
      { codexArgs: ['long task'] },
      {
        paths: { accounts: accountsPath, state: statePath },
        adapter,
        output: () => undefined,
        now: () => currentTime,
        leaseHeartbeatMs: 5
      }
    );
    const handle = await adapter.waitForHandle();
    try {
      let leases = Object.values((await loadStateFile(statePath)).leases);
      expect(leases[0]?.accountName).toBe('relay-a');

      currentTime = new Date('2026-05-19T00:01:00.000Z');
      await waitFor(async () => {
        leases = Object.values((await loadStateFile(statePath)).leases);
        return leases[0]?.updatedAt === '2026-05-19T00:01:00.000Z';
      });
      expect(leases[0]).toMatchObject({
        accountName: 'relay-a',
        updatedAt: '2026-05-19T00:01:00.000Z',
        expiresAt: '2026-05-19T00:03:00.000Z'
      });
    } finally {
      handle.exit();
      await run;
    }
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

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\nHTTP 401 invalid api key\n`],
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
    expect(adapter.spawns[1]?.args).toContain(sessionId);
    expect(adapter.spawns[2]?.args).toContain(sessionId);
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

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      {
        chunks: [`session_id: ${sessionId}\ntoo many requests\n`],
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

  it('records retry cooldowns from detector output', async () => {
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

  it('skips cooling accounts when rotating after a failed attempt', async () => {
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
    await addAccount(accountsPath, {
      name: 'relay-c',
      apiKey: 'sk-c',
      baseUrl: 'https://c.example.com/v1'
    });
    await recordAccountFailure(healthPath, {
      accountName: 'relay-b',
      baseUrl: 'https://b.example.com/v1',
      reason: 'auth',
      now: new Date('2026-05-19T00:00:00.000Z')
    });

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\nHTTP 401 invalid api key\n`],
      ['continued\n']
    ]);

    const result = await runManagedCodex(
      { codexArgs: ['do task'], accountName: 'relay-a' },
      {
        paths: { accounts: accountsPath, state: statePath, health: healthPath, rotationLog: rotationLogPath },
        adapter,
        output: () => undefined,
        now: () => new Date('2026-05-19T00:01:00.000Z')
      }
    );

    expect(result.usedAccount).toBe('relay-c');
    expect(adapter.spawns.map((spawn) => spawn.env.OPENAI_API_KEY)).toEqual(['sk-a', 'sk-c']);
    const log = await readFile(rotationLogPath, 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      fromAccount: 'relay-a',
      toAccount: 'relay-c',
      reason: 'auth',
      resumeMode: 'session',
      sessionId
    });
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

    const sessionId = '019e365c-a287-74a3-890e-5b23a633f3c1';
    const adapter = new FakeAdapter([
      [`session_id: ${sessionId}\ninsufficient balance\n`],
      [`session_id: ${sessionId}\nHTTP 401 invalid api key\n`]
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

type FakeScript = string[] | { chunks: string[]; exitCode: number; autoExit?: boolean; emitExitOnKill?: boolean };

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
      : new FakeHandle(script.chunks, script.exitCode, script.autoExit ?? true, script.emitExitOnKill ?? true);
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
    private readonly autoExit = true,
    private readonly emitExitOnKill = true
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
    if (this.emitExitOnKill) {
      this.emit('exit', { exitCode: 1, signal: null });
    }
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

function randomTestDirName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}
