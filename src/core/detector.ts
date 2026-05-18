import stripAnsi from 'strip-ansi';
import type { DetectorMatch } from '../types.js';

const HIGH_PATTERNS = [
  /insufficient\s+balance/i,
  /余额不足/i,
  /usage\s+limit\s+exceeded/i,
  /quota\s+exceeded/i,
  /您的.*额度.*不足/i,
  /credit(?:s)?\s+exhausted/i,
  /payment\s+required/i,
  /HTTP\s*402/i,
  /invalid\s+api\s+key/i,
  /unauthorized/i,
  /HTTP\s*401/i
];

const MEDIUM_PATTERNS = [
  /rate\s+limit/i,
  /too\s+many\s+requests/i,
  /please\s+try\s+again/i,
  /temporarily\s+unavailable/i,
  /model.*not.*available/i,
  /upstream.*error/i
];

const RETRY_AFTER_SECONDS = /retry\s+after\s+(\d+)\s*s/i;
const AVAILABLE_IN = /available\s+in\s+(\d+)\s*(second|seconds|minute|minutes)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export function detectOutput(raw: string, customQuotaPatterns: string[] = []): DetectorMatch {
  const output = stripAnsi(raw);
  const retryAfterMs = extractRetryAfterMs(output);

  for (const pattern of customQuotaPatterns) {
    if (pattern && output.toLowerCase().includes(pattern.toLowerCase())) {
      return withRetry({ confidence: 'high', matchedText: pattern }, retryAfterMs);
    }
  }

  for (const pattern of HIGH_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[0]) {
      return withRetry({ confidence: 'high', matchedText: match[0] }, retryAfterMs);
    }
  }

  for (const pattern of MEDIUM_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[0]) {
      return withRetry({ confidence: 'medium', matchedText: match[0] }, retryAfterMs);
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
