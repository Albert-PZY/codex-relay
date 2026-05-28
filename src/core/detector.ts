import { stripVTControlCharacters } from 'node:util';
import type { DetectorMatch, HealthFailureReason } from '../types.js';

interface DetectionPattern {
  pattern: RegExp;
  reason: HealthFailureReason;
}

const HIGH_PATTERNS: DetectionPattern[] = [
  { pattern: /insufficient\s+balance/i, reason: 'quota' },
  { pattern: /余额不足/i, reason: 'quota' },
  { pattern: /usage\s+limit\s+exceeded/i, reason: 'quota' },
  { pattern: /quota\s+exceeded/i, reason: 'quota' },
  { pattern: /您的.*额度.*不足/i, reason: 'quota' },
  { pattern: /credit(?:s)?\s+exhausted/i, reason: 'quota' },
  { pattern: /payment\s+required/i, reason: 'quota' },
  { pattern: /HTTP\s*402/i, reason: 'quota' },
  { pattern: /payload\s+too\s+large/i, reason: 'quota' },
  { pattern: /request\s+body\s+exceeds/i, reason: 'quota' },
  { pattern: /tier\s+limit/i, reason: 'quota' },
  { pattern: /HTTP\s*413/i, reason: 'quota' },
  { pattern: /status\s+413/i, reason: 'quota' },
  { pattern: /invalid\s+api\s+key/i, reason: 'auth' },
  { pattern: /api\s*key.*(?:disabled|deactivated|revoked|blocked)/i, reason: 'auth' },
  { pattern: /api\s*key.*(?:已被禁用|被禁用|已禁用|无效)/i, reason: 'auth' },
  { pattern: /unauthorized/i, reason: 'auth' },
  { pattern: /forbidden/i, reason: 'auth' },
  { pattern: /HTTP\s*401/i, reason: 'auth' },
  { pattern: /HTTP\s*403/i, reason: 'auth' },
  { pattern: /status\s+40[13]/i, reason: 'auth' }
];

const MEDIUM_PATTERNS: DetectionPattern[] = [
  { pattern: /rate\s+limit/i, reason: 'rate_limit' },
  { pattern: /too\s+many\s+requests/i, reason: 'rate_limit' },
  { pattern: /HTTP\s*429/i, reason: 'rate_limit' },
  { pattern: /please\s+try\s+again/i, reason: 'rate_limit' },
  { pattern: /unexpected\s+status/i, reason: 'unknown' },
  { pattern: /temporarily\s+unavailable/i, reason: 'server' },
  { pattern: /model.*not.*available/i, reason: 'server' },
  { pattern: /upstream.*error/i, reason: 'server' },
  { pattern: /upstream.*(?:timeout|timed\s*out|failed|unavailable)/i, reason: 'server' },
  { pattern: /stream\s+(?:error|disconnected|closed|aborted)/i, reason: 'server' },
  { pattern: /connection\s+(?:reset|closed|aborted|refused)/i, reason: 'server' },
  { pattern: /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED)\b/i, reason: 'server' },
  { pattern: /network\s+error/i, reason: 'server' },
  { pattern: /request\s+(?:failed|timed\s*out)/i, reason: 'server' },
  { pattern: /provider.*error/i, reason: 'server' },
  { pattern: /HTTP\s*50[0-4]/i, reason: 'server' }
];

const RETRY_AFTER_SECONDS = /retry\s+after\s+(\d+)\s*s/i;
const AVAILABLE_IN = /available\s+in\s+(\d+)\s*(second|seconds|minute|minutes)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const MCP_STARTUP_LINE = /Starting\s+MCP\s+servers\s+\((\d+)\/(\d+)\)/gi;

export function detectOutput(raw: string, customQuotaPatterns: string[] = []): DetectorMatch {
  const output = stripVTControlCharacters(raw);
  const retryAfterMs = extractRetryAfterMs(output);

  for (const pattern of customQuotaPatterns) {
    if (pattern && output.toLowerCase().includes(pattern.toLowerCase())) {
      return withRetry({ confidence: 'high', matchedText: pattern, reason: 'quota' }, retryAfterMs);
    }
  }

  for (const { pattern, reason } of HIGH_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[0]) {
      return withRetry({ confidence: 'high', matchedText: match[0], reason }, retryAfterMs);
    }
  }

  for (const { pattern, reason } of MEDIUM_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[0]) {
      return withRetry({ confidence: 'medium', matchedText: match[0], reason }, retryAfterMs);
    }
  }

  return withRetry({ confidence: 'none' }, retryAfterMs);
}

export function extractSessionId(raw: string): string | undefined {
  const output = stripVTControlCharacters(raw);
  const match = output.match(UUID);
  return match?.[0];
}

export function isMcpStartupPending(raw: string): boolean {
  const output = stripVTControlCharacters(raw);
  let lastMatch: RegExpExecArray | null = null;
  for (const match of output.matchAll(MCP_STARTUP_LINE)) {
    lastMatch = match;
  }
  if (!lastMatch?.[1] || !lastMatch[2]) {
    return false;
  }
  return Number.parseInt(lastMatch[1], 10) < Number.parseInt(lastMatch[2], 10);
}

function extractRetryAfterMs(output: string): number | undefined {
  const retrySeconds = output.match(RETRY_AFTER_SECONDS)?.[1];
  if (retrySeconds) {
    return Number.parseInt(retrySeconds, 10) * 1000;
  }

  const available = output.match(AVAILABLE_IN);
  if (available?.[1] && available[2]) {
    const value = Number.parseInt(available[1], 10);
    return available[2].startsWith('minute') ? value * 60_000 : value * 1000;
  }

  return undefined;
}

function withRetry(match: DetectorMatch, retryAfterMs: number | undefined): DetectorMatch {
  if (retryAfterMs === undefined) {
    return match;
  }
  return {
    ...match,
    retryAfterMs
  };
}
