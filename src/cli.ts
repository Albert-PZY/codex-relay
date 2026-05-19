import { Command } from 'commander';
import { access } from 'node:fs/promises';
import {
  addAccount,
  importAccountsFromFile,
  loadAccountsFile,
  mergeImportedAccounts,
  removeAccount,
  setPreferredAccount,
  type AccountInput
} from './core/accounts.js';
import { loadStateFile } from './core/state.js';
import { runManagedCodex as defaultRunManagedCodex } from './core/runner.js';
import { resolveDataPaths, type DataPaths } from './utils/paths.js';
import type { RunnerOptions, SpawnResult } from './types.js';

export interface CliDependencies {
  paths?: Pick<DataPaths, 'accounts' | 'state'>;
  output?: (text: string) => void;
  error?: (text: string) => void;
  fetch?: typeof fetch;
  runManagedCodex?: (
    options: RunnerOptions,
    dependencies: Parameters<typeof defaultRunManagedCodex>[1]
  ) => Promise<SpawnResult>;
}

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const paths = dependencies.paths ?? resolveDataPaths();
  const output = dependencies.output ?? ((text: string) => console.log(text));
  const error = dependencies.error ?? ((text: string) => console.error(text));
  const fetchImpl = dependencies.fetch ?? fetch;
  const runManagedCodex = dependencies.runManagedCodex ?? defaultRunManagedCodex;
  const program = new Command();

  program
    .name('codex-relay')
    .description('Relay account pool manager for the Codex CLI')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .exitOverride();

  program
    .command('add')
    .argument('<name>')
    .option('--key <key>')
    .option('--base-url <url>')
    .option('--model <model>')
    .option('--overwrite')
    .action(async (name: string, options: { key?: string; baseUrl?: string; model?: string; overwrite?: boolean }) => {
      const account = await resolveAccountInput(name, options);
      await addAccount(paths.accounts, account, { overwrite: Boolean(options.overwrite) });
      output(`Added ${account.name}`);
    });

  program
    .command('list')
    .action(async () => {
      const file = await loadAccountsFile(paths.accounts);
      const state = await loadStateFile(paths.state);
      if (file.accounts.length === 0) {
        output('No accounts configured.');
        return;
      }
      for (const account of file.accounts) {
        const marker = account.name === file.preferred ? '*' : ' ';
        const retry = state.retryAvailability[account.name];
        const status = retry ? `retry at ${retry.displayText}` : 'active';
        output(`${marker} ${account.name} ${account.baseUrl} ${status}`);
      }
    });

  program
    .command('remove')
    .argument('<name>')
    .action(async (name: string) => {
      await removeAccount(paths.accounts, name);
      output(`Removed ${name}`);
    });

  program
    .command('use')
    .argument('<name>')
    .action(async (name: string) => {
      await setPreferredAccount(paths.accounts, name);
      output(`Using ${name}`);
    });

  program
    .command('import')
    .argument('<file>')
    .action(async (filePath: string) => {
      const accounts = await importAccountsFromFile(filePath);
      const imported = await mergeImportedAccounts(paths.accounts, accounts);
      outputImportSummary(output, 'Imported', imported.length, accounts.length - imported.length);
    });

  program
    .command('setup')
    .argument('[file]', 'setup file path', 'data.json')
    .action(async (filePath: string) => {
      const accounts = await importAccountsFromFile(filePath);
      const imported = await mergeImportedAccounts(paths.accounts, accounts);
      outputImportSummary(output, 'Imported', imported.length, accounts.length - imported.length);
      output('Run: codex-relay "your task"');
    });

  program
    .command('test')
    .argument('[name]')
    .action(async (name?: string) => {
      const file = await loadAccountsFile(paths.accounts);
      const accounts = name ? file.accounts.filter((account) => account.name === name) : file.accounts;
      if (name && accounts.length === 0) {
        throw new Error(`Account "${name}" does not exist.`);
      }
      for (const account of accounts) {
        const ok = await testRelayAccount(account, fetchImpl);
        output(`${account.name} ${ok ? 'OK' : 'FAILED'}`);
      }
    });

  program.action(async () => {
    const passthrough = parsePassthroughArgs(program.args);
    await autoSetupFromDefaultFile(paths.accounts, output);
    const runnerOptions: RunnerOptions = {
      codexArgs: passthrough.codexArgs
    };
    if (passthrough.accountName) {
      runnerOptions.accountName = passthrough.accountName;
    }
    const result = await runManagedCodex(runnerOptions, {
      paths,
      output
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
    if (isCommanderHelpExit(error)) {
      return;
    }
    throw error;
  }
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
  const { input } = await import('@inquirer/prompts');
  return input({ message });
}

async function autoSetupFromDefaultFile(accountsPath: string, output: (text: string) => void): Promise<void> {
  const file = await loadAccountsFile(accountsPath);
  if (file.accounts.length > 0 || !(await fileExists('data.json'))) {
    return;
  }

  const accounts = await importAccountsFromFile('data.json');
  const imported = await mergeImportedAccounts(accountsPath, accounts);
  outputImportSummary(output, 'Auto-imported', imported.length, accounts.length - imported.length, ' from data.json');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parsePassthroughArgs(args: string[]): { accountName?: string; codexArgs: string[] } {
  const codexArgs: string[] = [];
  let accountName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--account') {
      accountName = args[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith('--account=')) {
      accountName = arg.slice('--account='.length);
      continue;
    }
    if (arg !== undefined) {
      codexArgs.push(arg);
    }
  }

  return accountName ? { accountName, codexArgs } : { codexArgs };
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

async function testRelayAccount(account: Pick<AccountInput, 'apiKey' | 'baseUrl'>, fetchImpl: typeof fetch): Promise<boolean> {
  const endpoint = `${account.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${account.apiKey}`
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isCommanderHelpExit(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'commander.helpDisplayed';
}
