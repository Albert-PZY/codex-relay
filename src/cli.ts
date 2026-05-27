import { Command } from 'commander';
import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  addAccount,
  importAccountsFromFile,
  loadAccountsFile,
  mergeImportedAccounts,
  removeAccount,
  setPreferredAccount,
  type AccountInput
} from './core/accounts.js';
import {
  getAccountHealth,
  loadHealthFile,
  resetAccountCooldown,
  resetAllAccountCooldowns
} from './core/health.js';
import { loadStateFile, pruneExpiredLeases, saveStateFile } from './core/state.js';
import { withStoreLock } from './core/store-lock.js';
import {
  resolveCodexSpawnTarget,
  runManagedCodex as defaultRunManagedCodex
} from './core/runner.js';
import { resolveDataPaths, type DataPaths } from './utils/paths.js';
import type { AccountHealth, RunnerOptions, SpawnResult } from './types.js';

export interface CliDependencies {
  paths?: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'root' | 'health' | 'lock' | 'codexHome' | 'instances' | 'rotationLog'>>;
  output?: (text: string) => void;
  error?: (text: string) => void;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  runManagedCodex?: (
    options: RunnerOptions,
    dependencies: Parameters<typeof defaultRunManagedCodex>[1]
  ) => Promise<SpawnResult>;
}

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const paths = dependencies.paths ?? resolveDataPaths();
  const output = dependencies.output ?? ((text: string) => console.log(text));
  const rawOutput = dependencies.output ?? ((text: string) => process.stdout.write(text));
  const error = dependencies.error ?? ((text: string) => console.error(text));
  const fetchImpl = dependencies.fetch ?? fetch;
  const env = dependencies.env ?? process.env;
  const runManagedCodex = dependencies.runManagedCodex ?? defaultRunManagedCodex;
  const program = new Command();

  program
    .name('codex-relay')
    .usage('[options] [codex args...]')
    .description('Codex CLI relay account-pool manager with automatic rotation.\nCodex CLI 中转站号池管理和自动切号工具。')
    .version(getPackageVersion(), '-v, --version', 'Display codex-relay version / 显示 codex-relay 版本')
    .helpOption('-h, --help', 'Display help for command / 显示帮助信息')
    .option('--account <name>', 'Use a specific relay account for this run / 本次运行指定账号')
    .option('--no-resume', 'Do not auto-resume an interrupted session / 本次启动不自动恢复中断会话')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .exitOverride()
    .addHelpText('after', formatHelpDetails());

  program
    .command('version')
    .description('Show codex-relay version / 显示 codex-relay 版本')
    .action(() => {
      output(getPackageVersion());
    });

  program
    .command('add')
    .description('Add a relay account / 添加中转站账号')
    .argument('<name>')
    .option('--key <key>', 'API key / API key')
    .option('--base-url <url>', 'Relay base URL / 中转站 base URL')
    .option('--model <model>', 'Model used by this account / 该账号使用的模型')
    .option('--overwrite', 'Overwrite an existing account with the same name / 覆盖同名账号')
    .action(async (name: string, options: { key?: string; baseUrl?: string; model?: string; overwrite?: boolean }) => {
      const account = await resolveAccountInput(name, options);
      await withStoreLock(paths, async () => {
        await addAccount(paths.accounts, account, { overwrite: Boolean(options.overwrite) });
      });
      output(`Added ${account.name}`);
    });

  program
    .command('list')
    .description('List accounts and health status / 查看账号和健康状态')
    .action(async () => {
      const { file, state, health } = await withStoreLock(paths, async () => ({
        file: await loadAccountsFile(paths.accounts),
        state: await loadFreshState(paths.state),
        health: await loadHealthFile(resolveHealthPath(paths))
      }));
      if (file.accounts.length === 0) {
        output('No accounts configured.');
        return;
      }
      for (const account of file.accounts) {
        const marker = account.name === file.preferred ? '*' : ' ';
        const status = formatHealthStatus(getAccountHealth(account, health));
        const leaseText = countActiveLeases(state, account.name) > 0 ? ' in-use' : '';
        output(`${marker} ${account.name} ${account.baseUrl} ${status}${leaseText}`);
      }
    });

  program
    .command('remove')
    .description('Remove an account / 删除账号')
    .argument('<name>')
    .action(async (name: string) => {
      await withStoreLock(paths, async () => {
        await removeAccount(paths.accounts, name);
      });
      output(`Removed ${name}`);
    });

  program
    .command('use')
    .description('Set the preferred account / 设置默认优先账号')
    .argument('<name>')
    .action(async (name: string) => {
      await withStoreLock(paths, async () => {
        await setPreferredAccount(paths.accounts, name);
      });
      output(`Using ${name}`);
    });

  program
    .command('import')
    .description('Import accounts from JSON / 从 JSON 导入账号')
    .argument('<file>')
    .action(async (filePath: string) => {
      const accounts = await importAccountsFromFile(filePath);
      const imported = await withStoreLock(paths, async () => mergeImportedAccounts(paths.accounts, accounts));
      outputImportSummary(output, 'Imported', imported.length, accounts.length - imported.length);
    });

  program
    .command('setup')
    .description('Initialize the account pool from JSON / 从 JSON 初始化号池')
    .argument('[file]', 'setup file path', 'data.json')
    .action(async (filePath: string) => {
      const accounts = await importAccountsFromFile(filePath);
      const imported = await withStoreLock(paths, async () => mergeImportedAccounts(paths.accounts, accounts));
      outputImportSummary(output, 'Imported', imported.length, accounts.length - imported.length);
      output('Run: codex-relay "your task"');
    });

  program
    .command('test')
    .description('Run a lightweight relay check / 轻量预检账号')
    .argument('[name]')
    .action(async (name?: string) => {
      const file = await withStoreLock(paths, async () => loadAccountsFile(paths.accounts));
      const accounts = name ? file.accounts.filter((account) => account.name === name) : file.accounts;
      if (name && accounts.length === 0) {
        throw new Error(`Account "${name}" does not exist.`);
      }
      for (const account of accounts) {
        const status = await testRelayAccount(account, fetchImpl);
        output(`${account.name} ${formatRelayTestStatus(status)}`);
      }
    });

  program
    .command('health')
    .description('Show account health records / 查看账号健康记录')
    .action(async () => {
      const { file, health } = await withStoreLock(paths, async () => ({
        file: await loadAccountsFile(paths.accounts),
        health: await loadHealthFile(resolveHealthPath(paths))
      }));
      if (file.accounts.length === 0 && health.retired.length === 0) {
        output('No health records.');
        return;
      }

      for (const account of file.accounts) {
        output(`${account.name} ${formatHealthStatus(getAccountHealth(account, health))}`);
      }
      for (const retired of health.retired) {
        const count = retired.cooldownCount !== undefined ? ` cooldowns=${retired.cooldownCount}` : '';
        output(`${retired.name} retired ${retired.reason} at ${retired.removedAt}${count}`);
      }
    });

  program
    .command('doctor')
    .description('Run local diagnostics / 本地环境诊断')
    .action(async () => {
      const report = await buildDoctorReport(paths, env);
      for (const line of report) {
        output(line);
      }
    });

  const resetCommand = program
    .command('reset')
    .description('Clear local runtime state / 清理本地运行状态')
    .option('--resume', 'Clear pending resume sessions / 清理待恢复会话')
    .option('--leases', 'Clear active account leases / 清理账号租约')
    .action(async (options: { resume?: boolean; leases?: boolean }) => {
      if (!options.resume && !options.leases) {
        throw new Error('Choose what to reset: --resume and/or --leases.');
      }
      await withStoreLock(paths, async () => {
        const state = await loadStateFile(paths.state);
        const nextState = {
          ...state,
          updatedAt: new Date().toISOString()
        };
        if (options.resume) {
          delete nextState.pendingResumes;
        }
        if (options.leases) {
          nextState.leases = {};
        }
        await saveStateFile(paths.state, nextState);
      });
      if (options.resume) {
        output('Cleared pending resume sessions.');
      }
      if (options.leases) {
        output('Cleared active account leases.');
      }
    });

  resetCommand
    .command('cooldown [name]')
    .description('Reset account cooldown state / 重置账号冷却状态')
    .option('--all', 'Reset all account cooldowns / 重置全部账号冷却')
    .action(async (name: string | undefined, options: { all?: boolean }) => {
      if (options.all && name) {
        throw new Error('Use either reset cooldown <name> or reset cooldown --all, not both.');
      }
      if (!options.all && !name) {
        throw new Error('Choose an account name or pass --all.');
      }
      const count = await withStoreLock(paths, async () => {
        const file = await loadAccountsFile(paths.accounts);
        const healthPath = resolveHealthPath(paths);
        if (options.all) {
          await resetAllAccountCooldowns(healthPath, file.accounts);
          return file.accounts.length;
        }
        const account = file.accounts.find((candidate) => candidate.name === name);
        if (!account) {
          throw new Error(`Account "${name}" does not exist.`);
        }
        await resetAccountCooldown(healthPath, account);
        return 1;
      });
      output(options.all ? `Reset cooldown for ${count} accounts.` : `Reset cooldown for ${name}.`);
    });

  program.action(async () => {
    const options = program.opts<{ account?: string; resume?: boolean }>();
    await autoSetupFromDefaultFile(paths, output);
    const runnerOptions: RunnerOptions = {
      codexArgs: program.args,
      disableResume: options.resume === false
    };
    if (options.account) {
      runnerOptions.accountName = options.account;
    }
    const result = await runManagedCodex(runnerOptions, {
      paths,
      output: rawOutput,
      outputStream: process.stdout
    });
    if (result.exitCode && result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  });

  program.configureOutput({
    writeOut: (text) => output(text.trimEnd()),
    writeErr: (text) => error(text.trimEnd())
  });

  return program;
}

export async function main(argv: string[] = []): Promise<void> {
  const program = createCliProgram();
  try {
    await program.parseAsync(['node', 'codex-relay', ...argv]);
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      return;
    }
    throw error;
  }
}

function getPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require('../package.json') as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}

function formatHelpDetails(): string {
  return `
Examples / 示例:
  $ codex-relay setup ./accounts.json
    Initialize the pool from JSON.
    从 JSON 文件初始化号池。

  $ codex-relay
    Start Codex with an injected relay account.
    启动 Codex，并自动注入号池账号。

  $ codex-relay "fix this bug"
    Run a Codex task with automatic rotation and resume.
    执行 Codex 任务，失败时自动切号并恢复上下文。

  $ codex-relay --account relay-a "continue"
    Use one account only for this run.
    本次运行临时指定账号。

JSON import format / JSON 导入格式:
  [
    { "baseUrl": "https://relay.example.com/v1", "apiKey": "sk-xxx", "name": "relay-a", "model": "gpt-5.2" }
  ]

Notes / 说明:
  - "name" and "model" are optional. Duplicate credentials are skipped automatically.
    "name" 和 "model" 可选，重复账号会自动跳过。
  - Unknown arguments are forwarded to Codex after codex-relay handles its own options.
    未识别参数会在 codex-relay 处理自身参数后继续传给 Codex。
`;
}

async function resolveAccountInput(
  name: string,
  options: { key?: string; baseUrl?: string; model?: string }
): Promise<AccountInput> {
  const apiKey = options.key || (await promptText('API key'));
  const baseUrl = options.baseUrl || (await promptText('Base URL'));
  const input: AccountInput = {
    name,
    apiKey,
    baseUrl
  };
  if (options.model) {
    input.model = options.model;
  }
  return input;
}

async function promptText(message: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return await readline.question(`${message}: `);
  } finally {
    readline.close();
  }
}

async function autoSetupFromDefaultFile(
  paths: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'lock'>>,
  output: (text: string) => void
): Promise<void> {
  const result = await withStoreLock(paths, async () => {
    const file = await loadAccountsFile(paths.accounts);
    if (file.accounts.length > 0 || !(await fileExists('data.json'))) {
      return undefined;
    }
    const accounts = await importAccountsFromFile('data.json');
    return {
      accounts,
      imported: await mergeImportedAccounts(paths.accounts, accounts)
    };
  });
  if (!result) {
    return;
  }
  outputImportSummary(
    output,
    'Auto-imported',
    result.imported.length,
    result.accounts.length - result.imported.length,
    ' from data.json'
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function outputImportSummary(
  output: (text: string) => void,
  verb: 'Imported' | 'Auto-imported',
  imported: number,
  skipped: number,
  suffix = ''
): void {
  output(`${verb} ${imported} account${imported === 1 ? '' : 's'}${suffix}`);
  if (skipped > 0) {
    output(`Skipped ${skipped} duplicate account${skipped === 1 ? '' : 's'}${suffix}`);
  }
}

function resolveHealthPath(paths: Pick<DataPaths, 'accounts' | 'state'> & Partial<Pick<DataPaths, 'health'>>): string {
  return paths.health ?? join(dirname(paths.state), 'health.json');
}

function formatHealthStatus(health: AccountHealth | undefined, now = new Date()): string {
  if (!isHealthCoolingDown(health, now)) {
    return 'active';
  }
  const reason = health.reason ?? 'unknown';
  const until = health.cooldownUntil ?? 'unknown';
  const count = health.cooldownCount ?? health.consecutiveFailures;
  return `cooldown ${reason} until ${until} cooldowns=${count}`;
}

function isHealthCoolingDown(health: AccountHealth | undefined, now = new Date()): health is AccountHealth {
  if (!health || health.status !== 'cooldown') {
    return false;
  }
  if (!health.cooldownUntil) {
    return true;
  }
  return new Date(health.cooldownUntil).getTime() > now.getTime();
}

async function loadFreshState(statePath: string): Promise<Awaited<ReturnType<typeof loadStateFile>>> {
  const state = await loadStateFile(statePath);
  const now = new Date();
  const pruned = pruneExpiredLeases(state, now);
  if (pruned === state) {
    return state;
  }
  const updated = {
    ...pruned,
    updatedAt: now.toISOString()
  };
  await saveStateFile(statePath, updated);
  return updated;
}

function countActiveLeases(state: Awaited<ReturnType<typeof loadStateFile>>, accountName: string): number {
  const nowMs = Date.now();
  return Object.values(state.leases).filter((lease) =>
    lease.accountName === accountName && new Date(lease.expiresAt).getTime() > nowMs
  ).length;
}

async function buildDoctorReport(paths: CliDependencies['paths'] extends undefined ? DataPaths : NonNullable<CliDependencies['paths']>, env: NodeJS.ProcessEnv): Promise<string[]> {
  const fullPaths = resolveDoctorPaths(paths);
  const accountsFile = await loadAccountsFile(fullPaths.accounts);
  const state = await loadFreshState(fullPaths.state);
  const health = await loadHealthFile(fullPaths.health);
  const codexTarget = resolveCodexSpawnTarget(env);
  const nodePtyStatus = resolveNodePtyStatus();
  const instanceCount = await countDirectories(fullPaths.instances);
  const lastRotation = await readLastLine(fullPaths.rotationLog);
  const activeLeases = Object.values(state.leases).filter((lease) => new Date(lease.expiresAt).getTime() > Date.now());
  const now = new Date();
  const cooldownCount = accountsFile.accounts.filter((account) =>
    isHealthCoolingDown(getAccountHealth(account, health), now)
  ).length;
  const pendingResumes = collectPendingResumeEntries(state);
  const lines = [
    'codex-relay doctor',
    `codex-relay: ${getPackageVersion()}`,
    `node: ${process.version}`,
    `node-pty: ${nodePtyStatus}`,
    `codex command: ${formatCodexTarget(codexTarget)}`,
    `relay home: ${fullPaths.root}`,
    `codex home: ${fullPaths.codexHome}`,
    `accounts: ${accountsFile.accounts.length} total, ${accountsFile.accounts.length - cooldownCount} active, ${cooldownCount} cooldown, ${health.retired.length} retired`,
    `preferred: ${accountsFile.preferred ?? 'none'}`,
    `last successful: ${state.lastSuccessfulAccount ?? 'none'}`,
    `pending resumes: ${pendingResumes.length}`,
    `active leases: ${activeLeases.length}`,
    `stale instance dirs: ${instanceCount}`,
    `last rotation: ${lastRotation ?? 'none'}`
  ];
  for (const pending of pendingResumes) {
    lines.push(`  resume ${pending.sessionId} cwd=${pending.cwd ?? 'unknown'} updated=${pending.updatedAt}`);
  }
  for (const lease of activeLeases) {
    lines.push(`  lease ${lease.accountName} pid=${lease.pid} cwd=${lease.cwd ?? 'unknown'} expires=${lease.expiresAt}`);
  }
  lines.push('network probe: skipped; run `codex-relay test` for lightweight /models checks.');
  return lines;
}

function resolveDoctorPaths(paths: NonNullable<CliDependencies['paths']>): DataPaths {
  const base = resolveDataPaths();
  return {
    root: paths.root ?? dirname(paths.state),
    accounts: paths.accounts,
    state: paths.state,
    health: paths.health ?? join(dirname(paths.state), 'health.json'),
    rotationLog: paths.rotationLog ?? join(dirname(paths.state), 'rotation.log'),
    lock: paths.lock ?? join(dirname(paths.state), 'store.lock'),
    codexHome: paths.codexHome ?? base.codexHome,
    instances: paths.instances ?? join(dirname(paths.state), 'instances')
  };
}

function resolveNodePtyStatus(): string {
  try {
    const require = createRequire(import.meta.url);
    require('node-pty');
    return 'ok';
  } catch {
    return 'missing';
  }
}

function formatCodexTarget(target: ReturnType<typeof resolveCodexSpawnTarget>): string {
  const args = target.argsPrefix.length > 0 ? ` ${target.argsPrefix.join(' ')}` : '';
  return `${target.command}${args}`;
}

function collectPendingResumeEntries(state: Awaited<ReturnType<typeof loadStateFile>>) {
  return Object.values(state.pendingResumes ?? {});
}

async function countDirectories(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if (isMissingFile(error)) {
      return 0;
    }
    throw error;
  }
}

async function readLastLine(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

type RelayTestStatus = 'OK' | 'UNKNOWN' | 'FAILED';

function formatRelayTestStatus(status: RelayTestStatus): string {
  return status === 'UNKNOWN'
    ? 'UNKNOWN probe-only'
    : status;
}

async function testRelayAccount(account: Pick<AccountInput, 'apiKey' | 'baseUrl'>, fetchImpl: typeof fetch): Promise<RelayTestStatus> {
  const endpoint = `${account.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${account.apiKey}`
      }
    });
    if (response.ok) {
      return 'OK';
    }
    if ([401, 402, 403].includes(response.status)) {
      return 'FAILED';
    }
    if ([404, 405, 429, 500, 501, 502, 503, 504].includes(response.status)) {
      return 'UNKNOWN';
    }
    return 'FAILED';
  } catch {
    return 'FAILED';
  }
}

function isCommanderDisplayExit(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['commander.helpDisplayed', 'commander.version'].includes(String(error.code));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
