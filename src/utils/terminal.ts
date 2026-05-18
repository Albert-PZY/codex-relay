export function restoreTerminal(output: NodeJS.WriteStream = process.stdout): void {
  if (!output.isTTY) {
    return;
  }
  output.write('\x1b[?2004l\x1b[?1l\x1b[?1049l\x1b>\r');
}
