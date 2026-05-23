import { describe, expect, it } from 'vitest';
import { detectOutput, extractSessionId } from '../src/core/detector.js';

describe('quota detector', () => {
  it('detects high-confidence quota signals', () => {
    expect(detectOutput('Error: insufficient balance')).toMatchObject({
      confidence: 'high',
      reason: 'quota'
    });
    expect(detectOutput('\u001b[31m余额不足\u001b[0m')).toMatchObject({
      confidence: 'high',
      reason: 'quota'
    });
  });

  it('classifies auth failures separately from quota failures', () => {
    expect(detectOutput('HTTP 401 invalid api key')).toMatchObject({
      confidence: 'high',
      reason: 'auth'
    });
    expect(
      detectOutput('unexpected status 403 Forbidden: {"error":"API Key 已被禁用"}')
    ).toMatchObject({
      confidence: 'high',
      reason: 'auth'
    });
  });

  it('detects payload and tier limit failures as quota signals', () => {
    expect(
      detectOutput(
        'unexpected status 413 Payload Too Large: Request body exceeds your tier limit (3MB for tier 0)'
      )
    ).toMatchObject({
      confidence: 'high',
      reason: 'quota'
    });
  });

  it('detects medium-confidence rate-limit signals', () => {
    expect(detectOutput('Too many requests, please try again later')).toMatchObject({
      confidence: 'medium',
      reason: 'rate_limit'
    });
    expect(detectOutput('Conversation interrupted - tell the model what to do differently.')).toMatchObject({
      confidence: 'medium',
      reason: 'unknown'
    });
  });

  it('classifies temporary upstream errors as server failures', () => {
    expect(detectOutput('upstream error: temporarily unavailable')).toMatchObject({
      confidence: 'medium',
      reason: 'server'
    });
  });

  it('extracts retry metadata without forcing high confidence', () => {
    const result = detectOutput('Please retry after 30s.');

    expect(result.confidence).toBe('none');
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('extracts available-in retry metadata in minutes', () => {
    const result = detectOutput('Model will be available in 2 minutes');

    expect(result.retryAfterMs).toBe(120_000);
  });

  it('supports custom quota patterns', () => {
    expect(detectOutput('balance depleted', ['balance depleted'])).toMatchObject({
      confidence: 'high',
      matchedText: 'balance depleted',
      reason: 'quota'
    });
  });

  it('extracts codex session ids from output', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const v7 = '019e365c-a287-74a3-890e-5b23a633f3c1';

    expect(extractSessionId(`session_id: ${id}`)).toBe(id);
    expect(extractSessionId(`Conversation ID ${id}`)).toBe(id);
    expect(extractSessionId(`Context 5% used  ${v7}`)).toBe(v7);
  });

  it('ignores normal transcript text', () => {
    expect(detectOutput('Here is the refactor plan.')).toEqual({
      confidence: 'none'
    });
    expect(extractSessionId('no uuid here')).toBeUndefined();
  });
});
