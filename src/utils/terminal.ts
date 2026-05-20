export function restoreTerminal(output: NodeJS.WriteStream = process.stdout): void {
  if (!output.isTTY) {
    return;
  }
  output.write([
    '\x1b[?1l',
    '\x1b[<u',
    '\x1b[>4;0m',
    '\x1b[?2004l',
    '\x1b[?1000l',
    '\x1b[?1002l',
    '\x1b[?1003l',
    '\x1b[?1004l',
    '\x1b[?1005l',
    '\x1b[?1006l',
    '\x1b[?1015l',
    '\x1b[?1047l',
    '\x1b[?1049l',
    '\x1b[?25h',
    '\x1b>',
    '\r'
  ].join(''));
}
