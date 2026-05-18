import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, readJsonFile } from '../src/utils/atomic.js';

const tmpDir = fileURLToPath(new URL('./tmp-atomic/', import.meta.url));

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('atomic utilities', () => {
  it('writes json atomically', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'state.json');

    await writeJsonAtomic(filePath, { value: 'ok' });

    await expect(readFile(filePath, 'utf8')).resolves.toContain('"value": "ok"');
  });

  it('reads json files', async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'state.json');
    await writeJsonAtomic(filePath, { value: 1 });

    await expect(readJsonFile(filePath)).resolves.toEqual({ value: 1 });
  });
});
