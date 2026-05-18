import { describe, expect, it } from 'vitest';
import { detectOutput, extractSessionId } from '../src/core/detector.js';

describe('quota detector', () => {
  it('detects high-confidence quota signals', () => {
    expect(detectOutput('Error: insufficient balance')).toMatchObject({
      confidence: 'high'
    });
    expect(detectOutput('\u001b[31m余额不足\u001b[0m')).toMatchObject({
      confidence: 'high'
    });
  });

  it('detects medium-confidence rate-limit signals', () => {
    expect(detectOutput('Too many requests, please try again later')).toMatchObject({
      confidence: 'medium'
    });
  });

  it('extracts retry metadata without forcing high confidence', () => {
    const result = detectOutput('Please retry after 30s.');

    expect(result.confidence).toBe('none');
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('supports custom quota patterns', () => {
    expect(detectOutput('balance depleted', ['balance depleted'])).toMatchObject({
      confidence: 'high',
      matchedText: 'balance depleted'
    });
  });

  it('extracts codex session ids from output', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';

    expect(extractSessionId(`session_id: ${id}`)).toBe(id);
    expect(extractSessionId(`Conversation ID ${id}`)).toBe(id);
  });
});
