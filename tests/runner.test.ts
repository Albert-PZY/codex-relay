import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAccount } from '../src/core/accounts.js';
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
      'hello'
    ]);
  });

  it('creates a default process adapter', () => {
    expect(createDefaultProcessAdapter()).toHaveProperty('spawn');
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
});

type FakeScript = string[] | { chunks: string[]; exitCode: number };

class FakeAdapter implements ProcessAdapter {
  public spawns: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  private readonly scripts: FakeScript[];

  constructor(scripts: FakeScript[]) {
    this.scripts = scripts;
  }

  spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): ProcessHandle {
    this.spawns.push({ command, args, env: options.env });
    const script = this.scripts.shift() ?? [];
    const handle = Array.isArray(script)
      ? new FakeHandle(script, 0)
      : new FakeHandle(script.chunks, script.exitCode);
    handle.start();
    return handle;
  }
}

class FakeHandle extends EventEmitter implements ProcessHandle {
  public killed = false;

  constructor(
    private readonly chunks: string[],
    private readonly exitCode: number
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
      this.emit('exit', { exitCode: this.exitCode, signal: null });
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
}
