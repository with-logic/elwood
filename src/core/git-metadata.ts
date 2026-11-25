/** Read bounded Git metadata without following a final symlink or waiting on a FIFO (C-CODEX-15). */
import { closeSync, constants, fstatSync, openSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { readExactDescriptorBytes, readExactDescriptorBytesAsync } from "./descriptor-bytes.ts";

const metadataFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Read strict UTF-8 from a bounded regular file. Non-files, oversized files, and
 * byte-count mismatches return undefined. An optional predicate can reject the
 * opened file. Filesystem and decoding errors propagate.
 */
export function readBoundedGitMetadata(
  path: string,
  maxBytes: number,
  verifyFile?: (info: Stats) => boolean,
): string | undefined {
  const fd = openSync(path, metadataFlags);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes || verifyFile?.(info) === false) return undefined;
    return decodeGitMetadata(readExactDescriptorBytes(fd, info.size));
  } finally {
    closeSync(fd);
  }
}

/**
 * Read strict UTF-8 from a bounded regular file without blocking on descriptor reads.
 * Non-files, oversized files, and length mismatches return undefined. Filesystem and
 * decoding errors propagate. The optional signal stops issuance of further reads.
 */
export async function readBoundedGitMetadataAsync(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const fd = await open(path, metadataFlags);
  try {
    signal?.throwIfAborted();
    const info = await fd.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return decodeGitMetadata(await readExactDescriptorBytesAsync(fd, info.size, signal));
  } finally {
    await fd.close();
  }
}

function decodeGitMetadata(bytes: Buffer | undefined): string | undefined {
  return bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Git pointers preserve significant spaces. Strip only the single line terminator. */
export function parseGitMetadataLine(contents: string | undefined): string | undefined {
  const value = contents?.replace(/\r?\n$/, "");
  return value && !/[\r\n\0]/.test(value) ? value : undefined;
}

export function matchesGitHeadMarkerShape(line: string): boolean {
  return /^(?:ref: refs\/\S+|[a-f0-9]{40}(?:[a-f0-9]{24})?)$/i.test(line);
}
