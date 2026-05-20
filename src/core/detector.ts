import stripAnsi from 'strip-ansi';
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
  { pattern: /invalid\s+api\s+key/i, reason: 'auth' },
  { pattern: /unauthorized/i, reason: 'auth' },
  { pattern: /HTTP\s*401/i, reason: 'auth' },
  { pattern: /HTTP\s*403/i, reason: 'auth' }
];

const MEDIUM_PATTERNS: DetectionPattern[] = [
  { pattern: /rate\s+limit/i, reason: 'rate_limit' },
  { pattern: /too\s+many\s+requests/i, reason: 'rate_limit' },
  { pattern: /HTTP\s*429/i, reason: 'rate_limit' },
  { pattern: /please\s+try\s+again/i, reason: 'rate_limit' },
  { pattern: /temporarily\s+unavailable/i, reason: 'server' },
  { pattern: /model.*not.*available/i, reason: 'server' },
  { pattern: /upstream.*error/i, reason: 'server' },
  { pattern: /HTTP\s*50[0-4]/i, reason: 'server' }
];

const RETRY_AFTER_SECONDS = /retry\s+after\s+(\d+)\s*s/i;
const AVAILABLE_IN = /available\s+in\s+(\d+)\s*(second|seconds|minute|minutes)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export function detectOutput(raw: string, customQuotaPatterns: string[] = []): DetectorMatch {
  const output = stripAnsi(raw);
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
  const output = stripAnsi(raw);
  const match = output.match(UUID);
  return match?.[0];
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
