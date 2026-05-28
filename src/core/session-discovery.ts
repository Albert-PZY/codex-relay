import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isMissingFile, sleep } from '../utils/fs.js';

const SESSION_DISCOVERY_POLL_INTERVAL_MS = 50;
export const SESSION_DISCOVERY_TIMEOUT_MS = 1_000;
const SESSION_HISTORY_TAIL_BYTES = 64 * 1024;

type SessionCandidate = {
  id: string;
  cwd: string | null;
  timestampMs: number;
};

export type SessionSelectionMode = 'closest-to-launch' | 'latest';

export async function snapshotKnownSessionIds(instanceDir: string): Promise<Map<string, number>> {
  const candidates = await readSessionCandidates(instanceDir);
  return new Map(candidates.map((candidate) => [candidate.id, candidate.timestampMs]));
}

export async function waitForSessionId(options: {
  instanceDir: string;
  workspaceDir: string;
  launchStartedAt: number;
  knownSessionIds: Map<string, number>;
  timeoutMs: number;
  selectionMode?: SessionSelectionMode;
  currentSessionId?: string | undefined;
}): Promise<string | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);

  while (true) {
    const candidates = await readSessionCandidates(options.instanceDir);
    const discovered = selectBestSessionCandidate(
      candidates.filter((candidate) => isNewOrUpdatedSessionCandidate(candidate, options.knownSessionIds)),
      options.workspaceDir,
      options.launchStartedAt,
      options.selectionMode ?? 'closest-to-launch',
      options.currentSessionId
    );
    if (discovered) {
      return discovered;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }
    await sleep(SESSION_DISCOVERY_POLL_INTERVAL_MS);
  }
}

function isNewOrUpdatedSessionCandidate(candidate: SessionCandidate, knownSessionIds: Map<string, number>): boolean {
  const knownTimestampMs = knownSessionIds.get(candidate.id);
  return knownTimestampMs === undefined || candidate.timestampMs > knownTimestampMs;
}

async function readSessionCandidates(instanceDir: string): Promise<SessionCandidate[]> {
  const [fromFiles, fromIndex, fromHistory] = await Promise.all([
    readSessionCandidatesFromFiles(instanceDir),
    readSessionCandidatesFromIndex(instanceDir),
    readSessionCandidatesFromHistory(instanceDir)
  ]);
  return mergeSessionCandidates([...fromFiles, ...fromIndex, ...fromHistory]);
}

async function readSessionCandidatesFromFiles(instanceDir: string): Promise<SessionCandidate[]> {
  const sessionFiles = await collectSessionFiles(join(instanceDir, 'sessions'));
  const candidates: SessionCandidate[] = [];

  for (const sessionFile of sessionFiles) {
    const candidate = await readSessionCandidateFromFile(sessionFile);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function findSessionFile(instanceDir: string, sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) {
    return undefined;
  }
  const sessionFiles = await collectSessionFiles(join(instanceDir, 'sessions'));
  return sessionFiles.find((sessionFile) => extractSessionIdFromFileName(sessionFile) === sessionId);
}

async function readSessionCandidateFromFile(sessionFile: string): Promise<SessionCandidate | undefined> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(sessionFile)).mtimeMs;
  } catch {
    return undefined;
  }

  const fileText = await readTextIfExists(sessionFile);
  const firstLine = fileText?.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine) {
    try {
      const parsed = JSON.parse(firstLine) as {
        type?: unknown;
        payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown };
      };
      if (parsed.type === 'session_meta' && typeof parsed.payload?.id === 'string') {
        return {
          id: parsed.payload.id,
          cwd: typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : null,
          timestampMs: parseDateMs(parsed.payload.timestamp) ?? mtimeMs
        };
      }
    } catch {
      // Fall back to filename extraction below.
    }
  }

  const idFromName = extractSessionIdFromFileName(sessionFile);
  return idFromName ? { id: idFromName, cwd: null, timestampMs: mtimeMs } : undefined;
}

async function readSessionCandidatesFromIndex(instanceDir: string): Promise<SessionCandidate[]> {
  const indexText = await readTextIfExists(join(instanceDir, 'session_index.jsonl'));
  if (!indexText) {
    return [];
  }

  const candidates: SessionCandidate[] = [];
  for (const line of indexText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { id?: unknown; updated_at?: unknown };
      const timestampMs = parseDateMs(parsed.updated_at);
      if (typeof parsed.id === 'string' && timestampMs !== null) {
        candidates.push({ id: parsed.id, cwd: null, timestampMs });
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

async function readSessionCandidatesFromHistory(instanceDir: string): Promise<SessionCandidate[]> {
  const historyText = await readTailTextIfExists(join(instanceDir, 'history.jsonl'), SESSION_HISTORY_TAIL_BYTES);
  if (!historyText) {
    return [];
  }

  const candidates: SessionCandidate[] = [];
  for (const line of historyText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as {
        session_id?: unknown;
        ts?: unknown;
        cwd?: unknown;
      };
      if (typeof parsed.session_id === 'string') {
        candidates.push({
          id: parsed.session_id,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
          timestampMs: parseTimestampMs(parsed.ts) ?? 0
        });
      }
    } catch {
      continue;
    }
  }
  return candidates;
}

async function collectSessionFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectSessionFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [entryPath] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

function selectBestSessionCandidate(
  candidates: SessionCandidate[],
  workspaceDir: string,
  launchStartedAt: number,
  selectionMode: SessionSelectionMode,
  currentSessionId: string | undefined
): string | undefined {
  const freshCandidates = candidates.filter((candidate) => candidate.timestampMs >= launchStartedAt - 60_000);
  const cwdMatched = freshCandidates.filter((candidate) => candidate.cwd === null || isSameCwd(candidate.cwd, workspaceDir));
  const ranked = (cwdMatched.length > 0 ? cwdMatched : freshCandidates).sort((left, right) => {
    if (selectionMode === 'latest') {
      const leftIsCurrent = currentSessionId !== undefined && left.id === currentSessionId;
      const rightIsCurrent = currentSessionId !== undefined && right.id === currentSessionId;
      if (leftIsCurrent !== rightIsCurrent) {
        return leftIsCurrent ? 1 : -1;
      }
      return right.timestampMs - left.timestampMs;
    }
    const leftDelta = Math.abs(left.timestampMs - launchStartedAt);
    const rightDelta = Math.abs(right.timestampMs - launchStartedAt);
    if (leftDelta !== rightDelta) {
      return leftDelta - rightDelta;
    }
    return right.timestampMs - left.timestampMs;
  });
  return ranked[0]?.id;
}

function mergeSessionCandidates(candidates: SessionCandidate[]): SessionCandidate[] {
  const merged = new Map<string, SessionCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.id);
    if (!existing || candidate.timestampMs > existing.timestampMs) {
      merged.set(candidate.id, {
        id: candidate.id,
        cwd: candidate.cwd ?? existing?.cwd ?? null,
        timestampMs: candidate.timestampMs
      });
    }
  }
  return [...merged.values()];
}

function parseDateMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value > 1e12 ? value : value * 1000;
  }
  return parseDateMs(value);
}

function extractSessionIdFromFileName(filePath: string): string | undefined {
  return basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1];
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readTailTextIfExists(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const handle = await open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      if (length <= 0) {
        return '';
      }

      const buffer = Buffer.alloc(length);
      const position = Math.max(0, size - length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

export function isSameCwd(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right;
}
