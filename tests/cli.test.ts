import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliProgram, main } from '../src/cli.js';
import { loadAccountsFile } from '../src/core/accounts.js';
import { loadHealthFile, recordAccountFailure, saveHealthFile } from '../src/core/health.js';
import { loadStateFile, saveStateFile } from '../src/core/state.js';

const promptQuestion = vi.hoisted(() => vi.fn());
const promptClose = vi.hoisted(() => vi.fn());

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: promptQuestion,
    close: promptClose
  })
}));

const tmpDir = fileURLToPath(new URL('./tmp-cli/', import.meta.url));
const accountsPath = join(tmpDir, 'accounts.json');
const statePath = join(tmpDir, 'state.json');
const healthPath = join(tmpDir, 'health.json');
const rotationLogPath = join(tmpDir, 'rotation.log');
const instancesPath = join(tmpDir, 'instances');
const codexHomePath = join(tmpDir, 'codex-home');

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  promptQuestion.mockReset();
  promptClose.mockReset();
  vi.restoreAllMocks();
});

describe('cli', () => {
  it('prints the codex-relay version without launching codex', async () => {
    const output: string[] = [];
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      runManagedCodex
    });

    await expect(program.parseAsync(['node', 'codex-relay', '--version'])).rejects.toMatchObject({
      code: 'commander.version'
    });

    expect(output).toEqual([await readPackageVersion()]);
    expect(runManagedCodex).not.toHaveBeenCalled();
  });

  it('prints the codex-relay version through the version command', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'version']);

    expect(output).toEqual([await readPackageVersion()]);
  });

  it('prints codex-relay help without launching codex', async () => {
    const output: string[] = [];
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      runManagedCodex
    });

    await expect(program.parseAsync(['node', 'codex-relay', '--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed'
    });

    const text = output.join('\n');
    expect(text).toContain('Usage: codex-relay [options] [codex args...]');
    expect(text).toContain('Codex CLI relay account-pool manager with automatic rotation.');
    expect(text).toContain('Codex CLI 中转站号池管理和自动切号工具。');
    expect(text).toContain('Options:');
    expect(text).toContain('--account <name>');
    expect(text).toContain('Commands:');
    expect(text).toContain('Examples / 示例:');
    expect(text).toContain('JSON import format / JSON 导入格式:');
    expect(text).toContain('Notes / 说明:');
    expect(text).toContain('Initialize the account pool from JSON / 从 JSON 初始化号池');
    expect(text).toContain('Show account health records / 查看账号健康记录');
    expect(runManagedCodex).not.toHaveBeenCalled();
  });

  it('adds, lists, uses, and removes accounts', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-b', '--key', 'sk-b', '--base-url', 'https://b.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'use', 'relay-b']);
    await program.parseAsync(['node', 'codex-relay', 'list']);
    await program.parseAsync(['node', 'codex-relay', 'remove', 'relay-a']);

    const file = await loadAccountsFile(accountsPath);
    expect(file.preferred).toBe('relay-b');
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-b']);
    expect(output.join('\n')).toContain('* relay-b');
  });

  it('prints an empty account list message', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'list']);

    expect(output).toEqual(['No accounts configured.']);
  });

  it('shows health cooldown status in the account list', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath, health: healthPath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });
    await program.parseAsync(['node', 'codex-relay', 'list']);

    expect(output.join('\n')).toContain('relay-a https://a.example.com/v1 cooldown quota until');
  });

  it('marks active account leases in the account list', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-b', '--key', 'sk-b', '--base-url', 'https://b.example.com/v1']);
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: 0,
        leases: {
          active: {
            accountName: 'relay-a',
            ownerId: 'active',
            pid: 1,
            startedAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z'
          },
          expired: {
            accountName: 'relay-b',
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

    await program.parseAsync(['node', 'codex-relay', 'list']);

    const text = output.join('\n');
    expect(text).toContain('relay-a https://a.example.com/v1 active in-use');
    expect(text).toContain('relay-b https://b.example.com/v1 active');
    expect(text).not.toContain('relay-b https://b.example.com/v1 active in-use');
  });

  it('prompts for missing add fields and stores the optional model', async () => {
    promptQuestion
      .mockResolvedValueOnce('sk-prompt')
      .mockResolvedValueOnce('https://prompt.example.com/v1');
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-prompt', '--model', 'gpt-5.2']);

    const file = await loadAccountsFile(accountsPath);
    expect(promptQuestion).toHaveBeenNthCalledWith(1, 'API key: ');
    expect(promptQuestion).toHaveBeenNthCalledWith(2, 'Base URL: ');
    expect(promptClose).toHaveBeenCalledTimes(2);
    expect(file.accounts[0]).toMatchObject({
      name: 'relay-prompt',
      apiKey: 'sk-prompt',
      baseUrl: 'https://prompt.example.com/v1',
      model: 'gpt-5.2'
    });
  });

  it('prints account health and retired records', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath, health: healthPath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-b', '--key', 'sk-b', '--base-url', 'https://b.example.com/v1']);
    await recordAccountFailure(healthPath, {
      accountName: 'relay-a',
      baseUrl: 'https://a.example.com/v1',
      reason: 'quota',
      now: new Date('2026-05-19T00:00:00.000Z')
    });
    const health = await loadHealthFile(healthPath);
    await saveHealthFile(healthPath, {
      version: 1,
      accounts: health.accounts,
      retired: [
        {
          name: 'relay-old',
          baseUrl: 'https://old.example.com/v1',
          reason: 'auth',
          firstFailedAt: '2026-05-01T00:00:00.000Z',
          lastFailedAt: '2026-05-10T00:00:00.000Z',
          removedAt: '2026-05-11T00:00:00.000Z'
        }
      ],
      updatedAt: '2026-05-19T00:00:00.000Z'
    });
    await program.parseAsync(['node', 'codex-relay', 'health']);

    expect(output.join('\n')).toContain('relay-a cooldown quota until');
    expect(output.join('\n')).toContain('relay-b active');
    expect(output.join('\n')).toContain('relay-old retired auth at 2026-05-11T00:00:00.000Z');
  });

  it('prints an empty health message when there are no accounts or records', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath, health: healthPath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'health']);

    expect(output).toEqual(['No health records.']);
  });

  it('prints local diagnostics with doctor', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: {
        root: tmpDir,
        accounts: accountsPath,
        state: statePath,
        health: healthPath,
        rotationLog: rotationLogPath,
        instances: instancesPath,
        codexHome: codexHomePath
      },
      output: (text) => output.push(text),
      env: { PATH: '' }
    });
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await saveStateFile(statePath, {
      version: 1,
      currentIndex: 0,
      lastSuccessfulAccount: 'relay-a',
      leases: {
        owner: {
          accountName: 'relay-a',
          ownerId: 'owner',
          pid: 123,
          cwd: 'C:/workspace/project',
          startedAt: '2026-05-23T00:00:00.000Z',
          updatedAt: '2026-05-23T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      },
      pendingResumes: {
        'c:/workspace/project': {
          sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
          prompt: 'Continue',
          cwd: 'C:/workspace/project',
          updatedAt: '2026-05-23T00:00:00.000Z'
        }
      },
      updatedAt: '2026-05-23T00:00:00.000Z'
    });
    await mkdir(instancesPath, { recursive: true });
    await mkdir(join(instancesPath, 'stale'), { recursive: true });
    await writeFile(rotationLogPath, '{"event":"account_rotation"}\n', 'utf8');

    await program.parseAsync(['node', 'codex-relay', 'doctor']);

    const text = output.join('\n');
    expect(text).toContain('codex-relay doctor');
    expect(text).toContain('accounts: 1 total');
    expect(text).toContain('pending resumes: 1');
    expect(text).toContain('active leases: 1');
    expect(text).toContain('stale instance dirs: 1');
    expect(text).toContain('last rotation: {"event":"account_rotation"}');
    expect(text).toContain('network probe: skipped');
  });

  it('prints diagnostics when optional runtime files are missing', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: {
        root: tmpDir,
        accounts: accountsPath,
        state: statePath,
        health: healthPath,
        rotationLog: rotationLogPath,
        instances: instancesPath,
        codexHome: codexHomePath
      },
      output: (text) => output.push(text),
      env: { PATH: '' }
    });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        currentIndex: 0,
        leases: {},
        pendingResumes: {
          'c:/workspace/project': {
            sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
            prompt: 'Continue',
            cwd: 'C:/workspace/project',
            updatedAt: '2026-05-23T00:00:00.000Z'
          }
        },
        updatedAt: '2026-05-23T00:00:00.000Z'
      }),
      'utf8'
    );

    await program.parseAsync(['node', 'codex-relay', 'doctor']);

    const text = output.join('\n');
    expect(text).toContain('node-pty:');
    expect(text).toContain('pending resumes: 1');
    expect(text).toContain('stale instance dirs: 0');
    expect(text).toContain('last rotation: none');
    expect(text).toContain('resume 019e365c-a287-74a3-890e-5b23a633f3c1 cwd=C:/workspace/project');
  });

  it('surfaces unexpected doctor instance path errors', async () => {
    const program = createCliProgram({
      paths: {
        root: tmpDir,
        accounts: accountsPath,
        state: statePath,
        health: healthPath,
        rotationLog: rotationLogPath,
        instances: instancesPath,
        codexHome: codexHomePath
      },
      output: () => undefined,
      env: { PATH: '' }
    });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(instancesPath, 'not-a-directory', 'utf8');

    await expect(program.parseAsync(['node', 'codex-relay', 'doctor'])).rejects.toMatchObject({
      code: 'ENOTDIR'
    });
  });

  it('surfaces unexpected doctor rotation log read errors', async () => {
    const program = createCliProgram({
      paths: {
        root: tmpDir,
        accounts: accountsPath,
        state: statePath,
        health: healthPath,
        rotationLog: rotationLogPath,
        instances: instancesPath,
        codexHome: codexHomePath
      },
      output: () => undefined,
      env: { PATH: '' }
    });
    await mkdir(rotationLogPath, { recursive: true });

    await expect(program.parseAsync(['node', 'codex-relay', 'doctor'])).rejects.toMatchObject({
      code: 'EISDIR'
    });
  });

  it('clears pending resumes and leases with reset', async () => {
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });
    await saveStateFile(statePath, {
      version: 1,
      currentIndex: 0,
      leases: {
        owner: {
          accountName: 'relay-a',
          ownerId: 'owner',
          pid: 123,
          startedAt: '2026-05-23T00:00:00.000Z',
          updatedAt: '2026-05-23T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      },
      pendingResumes: {
        'c:/workspace/project': {
          sessionId: '019e365c-a287-74a3-890e-5b23a633f3c1',
          prompt: 'Continue',
          cwd: 'C:/workspace/project',
          updatedAt: '2026-05-23T00:00:00.000Z'
        }
      },
      updatedAt: '2026-05-23T00:00:00.000Z'
    });

    await program.parseAsync(['node', 'codex-relay', 'reset', '--resume', '--leases']);

    const state = await loadStateFile(statePath);
    expect(state.pendingResumes).toBeUndefined();
    expect(state.leases).toEqual({});
    expect(output).toContain('Cleared pending resume sessions.');
    expect(output).toContain('Cleared active account leases.');
  });

  it('requires an explicit reset target', async () => {
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'reset'])).rejects.toThrow(
      /choose what to reset/i
    );
  });

  it('imports accounts from a json file', async () => {
    const importPath = join(tmpDir, 'import.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1'
        }
      ]),
      'utf8'
    );
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]?.name).toBe('relay-a');
  });

  it('rejects import files that are not top-level arrays', async () => {
    const importPath = join(tmpDir, 'wrapped.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify({
        accounts: [
          {
            name: 'relay-a',
            apiKey: 'sk-a',
            baseUrl: 'https://a.example.com/v1'
          }
        ]
      }),
      'utf8'
    );
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'import', importPath])).rejects.toThrow(
      /top-level array/i
    );
  });

  it('skips duplicate accounts during import', async () => {
    const importPath = join(tmpDir, 'duplicate.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          apiKey: 'sk-a',
          baseUrl: 'https://a.example.com/v1'
        },
        {
          name: 'relay-a',
          apiKey: 'sk-b',
          baseUrl: 'https://b.example.com/v1'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-a']);
    expect(file.accounts[0]?.apiKey).toBe('sk-a');
    expect(output.join('\n')).toContain('Imported 1 account');
    expect(output.join('\n')).toContain('Skipped 1 duplicate account');
  });

  it('sets up a json file with one base url', async () => {
    const importPath = join(tmpDir, 'data.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        },
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-two',
          name: 'relay-two'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync([
      'node',
      'codex-relay',
      'setup',
      importPath
    ]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-example-com-1', 'relay-two']);
    expect(output.join('\n')).toContain('Imported 2 accounts');
    expect(output.join('\n')).toContain('Run: codex-relay');
  });

  it('skips duplicate accounts during setup', async () => {
    const importPath = join(tmpDir, 'setup-duplicate.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        },
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        },
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-two'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync([
      'node',
      'codex-relay',
      'setup',
      importPath
    ]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual([
      'relay-example-com-1',
      'relay-example-com-2'
    ]);
    expect(output.join('\n')).toContain('Imported 2 accounts');
    expect(output.join('\n')).toContain('Skipped 1 duplicate account');
  });

  it('skips duplicate imported credentials that differ only by name', async () => {
    const importPath = join(tmpDir, 'duplicate-credentials.json');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      importPath,
      JSON.stringify([
        {
          name: 'relay-a',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-same'
        },
        {
          name: 'relay-b',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-same'
        }
      ]),
      'utf8'
    );
    const output: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text)
    });

    await program.parseAsync(['node', 'codex-relay', 'import', importPath]);

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts).toHaveLength(1);
    expect(output.join('\n')).toContain('Skipped 1 duplicate account');
  });

  it('sets up the default data.json when no file argument is provided', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'data.json'),
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        }
      ]),
      'utf8'
    );
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });
    const cwd = process.cwd();

    try {
      process.chdir(tmpDir);
      await program.parseAsync(['node', 'codex-relay', 'setup']);
    } finally {
      process.chdir(cwd);
    }

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]).toMatchObject({
      name: 'relay-example-com-1',
      apiKey: 'sk-one',
      baseUrl: 'https://relay.example.com/v1'
    });
  });

  it('tests accounts with an injected fetch implementation', async () => {
    const output: string[] = [];
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      fetch
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

    expect(fetch).toHaveBeenCalledWith('https://a.example.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-a' })
    }));
    expect(output.join('\n')).toContain('relay-a OK');
  });

  it('prints failed test status when the relay check throws', async () => {
    const output: string[] = [];
    const fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

    expect(output.join('\n')).toContain('relay-a FAILED');
  });

  it.each([401, 402, 403])(
    'prints failed test status when the relay check returns %s',
    async (status) => {
      const output: string[] = [];
      const fetch = vi.fn(async () => new Response('', { status }));
      const program = createCliProgram({
        paths: { accounts: accountsPath, state: statePath },
        output: (text) => output.push(text),
        fetch
      });

      await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
      await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

      expect(output.join('\n')).toContain('relay-a FAILED');
    }
  );

  it.each([404, 405, 429, 500, 501, 502, 503, 504])(
    'prints unknown test status when the relay check returns %s',
    async (status) => {
      const output: string[] = [];
      const fetch = vi.fn(async () => new Response('', { status }));
      const program = createCliProgram({
        paths: { accounts: accountsPath, state: statePath },
        output: (text) => output.push(text),
        fetch
      });

      await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
      await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

      expect(output.join('\n')).toContain('relay-a UNKNOWN probe-only');
    }
  );

  it('prints failed test status for non-standard relay responses', async () => {
    const output: string[] = [];
    const fetch = vi.fn(async () => new Response('', { status: 418 }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      fetch
    });

    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    await program.parseAsync(['node', 'codex-relay', 'test', 'relay-a']);

    expect(output.join('\n')).toContain('relay-a FAILED');
  });

  it('throws when testing a missing account', async () => {
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'test', 'missing'])).rejects.toThrow(
      /does not exist/i
    );
  });

  it('dispatches unknown commands to the managed runner', async () => {
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    await program.parseAsync(['node', 'codex-relay', '--account', 'relay-a', 'hello']);

    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        accountName: 'relay-a',
        codexArgs: ['hello']
      }),
      expect.objectContaining({ paths: { accounts: accountsPath, state: statePath } })
    );
  });

  it('passes no-resume to the managed runner', async () => {
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    await program.parseAsync(['node', 'codex-relay', '--no-resume', 'hello']);

    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        codexArgs: ['hello'],
        disableResume: true
      }),
      expect.anything()
    );
  });

  it('parses inline account passthrough options', async () => {
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-b'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    await program.parseAsync(['node', 'codex-relay', '--account=relay-b', 'hello']);

    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        accountName: 'relay-b',
        codexArgs: ['hello']
      }),
      expect.anything()
    );
  });

  it('sets process exitCode when the managed runner exits unsuccessfully', async () => {
    const previousExitCode = process.exitCode;
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 7,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });

    try {
      await program.parseAsync(['node', 'codex-relay', 'hello']);

      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('skips auto-import when accounts already exist', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'data.json'),
      JSON.stringify([
        {
          baseUrl: 'https://new.example.com/v1',
          apiKey: 'sk-new'
        }
      ]),
      'utf8'
    );
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-a'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });
    await program.parseAsync(['node', 'codex-relay', 'add', 'relay-a', '--key', 'sk-a', '--base-url', 'https://a.example.com/v1']);
    const cwd = process.cwd();

    try {
      process.chdir(tmpDir);
      await program.parseAsync(['node', 'codex-relay', 'hello']);
    } finally {
      process.chdir(cwd);
    }

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts.map((account) => account.name)).toEqual(['relay-a']);
  });

  it('auto-imports data.json before the first managed run', async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'data.json'),
      JSON.stringify([
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-one'
        }
      ]),
      'utf8'
    );
    const runManagedCodex = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      usedAccount: 'relay-example-com-1'
    }));
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: () => undefined,
      runManagedCodex
    });
    const cwd = process.cwd();

    try {
      process.chdir(tmpDir);
      await program.parseAsync(['node', 'codex-relay', 'hello']);
    } finally {
      process.chdir(cwd);
    }

    const file = await loadAccountsFile(accountsPath);
    expect(file.accounts[0]?.name).toBe('relay-example-com-1');
    expect(runManagedCodex).toHaveBeenCalledWith(
      expect.objectContaining({ codexArgs: ['hello'] }),
      expect.objectContaining({ paths: { accounts: accountsPath, state: statePath } })
    );
  });

  it('prints help without throwing an error from main', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main(['--help'])).resolves.toBeUndefined();

    expect(output.mock.calls.flat().join('\n')).toContain('Usage: codex-relay');
    expect(error).not.toHaveBeenCalled();
  });

  it('rethrows non-help errors from main', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(main(['import', join(tmpDir, 'missing.json')])).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('reports command errors through the configured error stream', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const program = createCliProgram({
      paths: { accounts: accountsPath, state: statePath },
      output: (text) => output.push(text),
      error: (text) => errors.push(text)
    });

    await expect(program.parseAsync(['node', 'codex-relay', 'remove', 'missing'])).rejects.toThrow(
      /does not exist/i
    );
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
  });
});

async function readPackageVersion(): Promise<string> {
  const manifestText = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestText) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}
