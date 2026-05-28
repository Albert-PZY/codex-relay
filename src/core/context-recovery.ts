import { open } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexOptionsWithValue, nonInteractiveSubcommands } from './codex-process.js';
import { findSessionFile } from './session-discovery.js';
import { isMissingFile } from '../utils/fs.js';

const SESSION_RECOVERY_SCAN_CHUNK_BYTES = 256 * 1024;

export interface ContextRecoveryInput {
  prompt: string;
  imagePaths: string[];
  hadImageReferences: boolean;
}

export async function buildContextRecoveryInput(options: {
  instanceDir: string;
  workspaceDir: string;
  sessionId?: string | undefined;
  codexArgs: string[];
}): Promise<ContextRecoveryInput> {
  const sessionFile = await findSessionFile(options.instanceDir, options.sessionId);
  const sessionInput = sessionFile
    ? await readLastUserInputFromSessionFile(sessionFile, options.workspaceDir)
    : undefined;
  const fallbackPrompt = extractPromptFromCodexArgs(options.codexArgs) ?? 'Continue';
  const prompt = sessionInput?.prompt || fallbackPrompt;
  return {
    prompt,
    imagePaths: sessionInput?.imagePaths ?? [],
    hadImageReferences: sessionInput?.hadImageReferences ?? false
  };
}

async function readLastUserInputFromSessionFile(sessionFile: string, workspaceDir: string): Promise<ContextRecoveryInput | undefined> {
  try {
    const handle = await open(sessionFile, 'r');
    try {
      const { size } = await handle.stat();
      let position = size;
      let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      while (position > 0) {
        const length = Math.min(position, SESSION_RECOVERY_SCAN_CHUNK_BYTES);
        position -= length;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
        const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
        const lines = splitLineBuffers(combined);
        carry = position > 0 ? lines.shift() ?? Buffer.alloc(0) : Buffer.alloc(0);

        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const input = extractRecoverableUserInputLine(decodeLineBuffer(lines[index]!), workspaceDir);
          if (input) {
            return input;
          }
        }
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  return undefined;
}

function splitLineBuffers(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      lines.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  lines.push(buffer.subarray(start));
  return lines;
}

function decodeLineBuffer(buffer: Buffer): string {
  const end = buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.length - 1 : buffer.length;
  return buffer.toString('utf8', 0, end).trim();
}

function extractRecoverableUserInputLine(line: string, workspaceDir: string): ContextRecoveryInput | undefined {
  if (!line || !mightContainUserInputLine(line)) {
    return undefined;
  }
  const parsed = parseJsonObject(line);
  if (!parsed) {
    return undefined;
  }
  const input = extractUserInput(parsed, workspaceDir);
  return input && !isAutomaticContinuePrompt(input.prompt) ? input : undefined;
}

function mightContainUserInputLine(line: string): boolean {
  return line.includes('"user"') || line.includes('user_message') || line.includes('user_input');
}

function isAutomaticContinuePrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return /^(?:continue|继续|接着|继续执行|继续你的任务)[.!。！]*$/.test(normalized);
}

function extractUserInput(value: unknown, workspaceDir: string): ContextRecoveryInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const role = readStringDeep(value, ['role']) ?? readStringDeep(value, ['message', 'role']) ?? readStringDeep(value, ['payload', 'role']);
  const topType = readStringDeep(value, ['type']);
  const payloadType = readStringDeep(value, ['payload', 'type']);
  const isUser =
    role === 'user' ||
    topType === 'user_message' ||
    topType === 'user_input' ||
    payloadType === 'user_message' ||
    payloadType === 'user_input';
  const chunks = collectInputChunks(value, workspaceDir);
  const prompt = chunks.textParts.join('\n').trim();
  if (!isUser || (!prompt && chunks.imagePaths.length === 0 && !chunks.hadImageReferences)) {
    return undefined;
  }
  return {
    prompt: prompt || 'Continue',
    imagePaths: [...new Set(chunks.imagePaths)],
    hadImageReferences: chunks.hadImageReferences
  };
}

function collectInputChunks(value: unknown, workspaceDir: string): { textParts: string[]; imagePaths: string[]; hadImageReferences: boolean } {
  const textParts: string[] = [];
  const imagePaths: string[] = [];
  let hadImageReferences = false;
  const seen = new Set<unknown>();

  const visit = (node: unknown, keyHint = ''): void => {
    if (node === null || node === undefined) {
      return;
    }
    if (typeof node === 'string') {
      if (isImageKey(keyHint)) {
        hadImageReferences = true;
        const imagePath = normalizeImagePath(node, workspaceDir);
        if (imagePath) {
          imagePaths.push(imagePath);
        }
        return;
      }
      if (isTextKey(keyHint) && node.trim()) {
        textParts.push(node.trim());
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, keyHint);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    if (/image/i.test(type)) {
      hadImageReferences = true;
    }
    for (const [key, child] of Object.entries(record)) {
      visit(child, key);
    }
  };

  visit(value);
  return { textParts: [...new Set(textParts)], imagePaths, hadImageReferences };
}

function extractPromptFromCodexArgs(codexArgs: string[]): string | undefined {
  const args = codexArgs.filter(Boolean);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') {
      return args.slice(index + 1).join(' ').trim() || undefined;
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
    if (nonInteractiveSubcommands.has(arg)) {
      continue;
    }
    return args.slice(index).join(' ').trim() || undefined;
  }
  return undefined;
}

export function buildContextRecoveryCodexArgs(input: ContextRecoveryInput): string[] {
  const args: string[] = [];
  for (const imagePath of input.imagePaths) {
    args.push('-i', imagePath);
  }
  args.push(buildContextRecoveryPrompt(input.prompt));
  return args;
}

function buildContextRecoveryPrompt(prompt: string): string {
  return [
    'The previous Codex session stopped because the conversation context exceeded the provider request-size limit.',
    'Start a fresh conversation and continue the user task below. If prior context is missing, infer only what is safe and ask for the missing details when necessary.',
    '',
    prompt
  ].join('\n');
}

export function formatContextRecoveryNotice(input: ContextRecoveryInput): string {
  const images = input.imagePaths.length > 0
    ? ` with ${input.imagePaths.length} image(s)`
    : input.hadImageReferences
      ? ' without recoverable image files'
      : '';
  return `\n[codex-relay] Context exceeded the provider request-size limit; starting a fresh conversation${images} from the last user request.\n`;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readStringDeep(record: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextKey(key: string): boolean {
  return /^(text|input|content|prompt|message)$/i.test(key);
}

function isImageKey(key: string): boolean {
  return /image|path|file/i.test(key);
}

function normalizeImagePath(value: string, workspaceDir: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('data:') || /^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  let path = trimmed;
  if (trimmed.startsWith('file://')) {
    try {
      path = fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  const extension = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
    return undefined;
  }
  return isAbsolute(path) ? path : resolve(workspaceDir, path);
}
