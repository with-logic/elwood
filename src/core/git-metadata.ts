/** Read bounded Git metadata without following a final symlink or waiting on a FIFO (C-CODEX-15). */
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { readExactDescriptorBytes } from "./descriptor-bytes.ts";

/**
 * Read strict UTF-8 from a bounded regular file. Non-files, oversized files, and
 * byte-count mismatches return undefined. Filesystem and decoding errors propagate.
 */
export function readBoundedGitMetadata(path: string, maxBytes: number): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const bytes = readExactDescriptorBytes(fd, info.size);
    return bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}
