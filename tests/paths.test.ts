import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveDataPaths } from '../src/utils/paths.js';

describe('path utilities', () => {
  it('uses CODEX_RELAY_HOME when set', () => {
    const paths = resolveDataPaths({ CODEX_RELAY_HOME: 'C:/tmp/relay' });

    expect(paths.root).toBe('C:/tmp/relay');
    expect(paths.accounts).toBe(join('C:/tmp/relay', 'accounts.json'));
    expect(paths.state).toBe(join('C:/tmp/relay', 'state.json'));
    expect(paths.health).toBe(join('C:/tmp/relay', 'health.json'));
    expect(paths.lock).toBe(join('C:/tmp/relay', 'store.lock'));
    expect(paths.codexHome).toBe(join('C:/tmp/relay', 'codex-home'));
  });
});
