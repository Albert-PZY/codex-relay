import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function appendLog(logDir: string, message: string, now = new Date()): Promise<void> {
  await mkdir(logDir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const line = `${now.toISOString()} ${message}\n`;
  await appendFile(join(logDir, `${day}.log`), line, 'utf8');
}
