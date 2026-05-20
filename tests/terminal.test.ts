import { describe, expect, it } from 'vitest';
import { restoreTerminal } from '../src/utils/terminal.js';

describe('terminal utilities', () => {
  it('does not write restore sequences for non-tty output', () => {
    const writes: string[] = [];
    const output = {
      isTTY: false,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      }
    } as unknown as NodeJS.WriteStream;

    restoreTerminal(output);

    expect(writes).toEqual([]);
  });

  it('writes restore sequences for tty output', () => {
    const writes: string[] = [];
    const output = {
      isTTY: true,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      }
    } as unknown as NodeJS.WriteStream;

    restoreTerminal(output);

    expect(writes[0]).toContain('\x1b[?2004l');
  });
});
