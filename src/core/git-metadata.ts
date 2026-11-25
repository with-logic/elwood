/** Read bounded Git metadata without following symlinks or waiting on special files (C-CODEX-15). */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedGitMetadata(path: string, maxBytes: number): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    // An extra byte detects a file that grew after fstat. Only zero proves EOF.
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count !== info.size) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
}
