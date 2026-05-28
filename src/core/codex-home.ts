import { copyFile, link, mkdir, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from '../utils/atomic.js';
import { isMissingFile } from '../utils/fs.js';
import type { DataPaths } from '../utils/paths.js';
import type { RelayAccount } from '../types.js';

type RunnerCodexHomePaths = Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'codexHome' | 'instances'>>;

export function resolveCodexHomePath(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'codexHome'>>): string {
  return paths.codexHome ?? join(dirname(paths.state), 'codex-home');
}

function resolveInstancesRoot(paths: Pick<DataPaths, 'state'> & Partial<Pick<DataPaths, 'instances'>>): string {
  return paths.instances ?? join(dirname(paths.state), 'instances');
}

export function resolveInstanceCodexHome(paths: RunnerCodexHomePaths, runId: string): string {
  return join(resolveInstancesRoot(paths), runId);
}

export async function prepareRunScopedCodexHome(
  instanceDir: string,
  sourceCodexHome: string,
  account: RelayAccount
): Promise<void> {
  await mkdir(sourceCodexHome, { recursive: true });
  await ensureSourceCodexHomeLayout(sourceCodexHome);
  await mkdir(dirname(instanceDir), { recursive: true });
  await rm(instanceDir, { recursive: true, force: true });
  await mkdir(instanceDir, { recursive: true });

  const entries = await readdir(sourceCodexHome, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'auth.json' || entry.name === 'config.toml' || entry.name === 'models_cache.json') {
      continue;
    }

    const target = join(sourceCodexHome, entry.name);
    const linkPath = join(instanceDir, entry.name);
    await createOverlayEntry(target, linkPath, entry.isDirectory());
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

export async function writeRunScopedAccountFiles(instanceDir: string, account: RelayAccount): Promise<void> {
  await writeCodexAuth(join(instanceDir, 'auth.json'), account.apiKey);
  await writeCodexConfig(join(instanceDir, 'config.toml'), account.baseUrl);
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
  let config = defaultCodexConfig('openai');
  try {
    const existing = await readFile(filePath, 'utf8');
    if (existing.trim()) {
      config = existing;
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const provider = findTomlStringValue(config, 'model_provider') ?? 'openai';
  await writeTextAtomic(filePath, setProviderBaseUrl(config, provider, baseUrl));
}

function setProviderBaseUrl(config: string, provider: string, baseUrl: string): string {
  const providerHeader = new RegExp(`(\\[model_providers\\.${escapeRegExp(provider)}\\][\\s\\S]*?)(?=\\n\\[|$)`);
  if (providerHeader.test(config)) {
    return config.replace(providerHeader, (block) => {
      if (/^base_url\s*=/m.test(block)) {
        return block.replace(/^base_url\s*=.*$/m, `base_url = ${tomlString(baseUrl)}`);
      }
      const trimmedBlock = block.endsWith('\n') ? block : `${block}\n`;
      return `${trimmedBlock}base_url = ${tomlString(baseUrl)}\n`;
    });
  }

  const suffix = config.endsWith('\n') ? '' : '\n';
  return `${config}${suffix}\n[model_providers.${provider}]\nname = ${tomlString(provider)}\nbase_url = ${tomlString(baseUrl)}\n`;
}

function defaultCodexConfig(provider: string): string {
  return `model_provider = ${tomlString(provider)}\n\n[model_providers.${provider}]\nname = ${tomlString(provider)}\n`;
}

function findTomlStringValue(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\"([^\"]+)\"`, 'm'));
  return match?.[1];
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
