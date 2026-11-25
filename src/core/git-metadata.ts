/** Read bounded Git metadata without following a final symlink or waiting on a FIFO (C-CODEX-15). */
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { readExactDescriptorBytesAsync } from "./descriptor-bytes.ts";

const metadataFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Read strict UTF-8 from a bounded regular file without blocking on descriptor reads.
 * Non-files, oversized files, and length mismatches return undefined. Filesystem and
 * decoding errors propagate. The optional signal stops issuance of further reads.
 * A verifier can reject the opened descriptor before reading, which returns undefined.
 */
export async function readBoundedGitMetadataAsync(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
  verifyFile?: (info: Stats) => boolean,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const fd = await open(path, metadataFlags);
  try {
    signal?.throwIfAborted();
    const info = await fd.stat();
    if (!info.isFile() || info.size > maxBytes || verifyFile?.(info) === false) return undefined;
    const bytes = await readExactDescriptorBytesAsync(fd, info.size, signal);
    return bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await fd.close();
  }
}

/** Git pointers preserve significant spaces. Strip only the single line terminator. */
export function parseGitMetadataLine(contents: string | undefined): string | undefined {
  const value = contents?.replace(/\r?\n$/, "");
  return value && !/[\r\n\0]/.test(value) ? value : undefined;
}

export function matchesGitHeadMarkerShape(line: string): boolean {
  return /^(?:ref: refs\/\S+|[a-f0-9]{40}(?:[a-f0-9]{24})?)$/i.test(line);
}
