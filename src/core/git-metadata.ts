/** Read bounded Git metadata without following a final symlink or waiting on a FIFO (C-CODEX-15). */
import { closeSync, constants, fstatSync, openSync, type Stats } from "node:fs";
import { readExactDescriptorBytes } from "./descriptor-bytes.ts";

/**
 * Read strict UTF-8 from a bounded regular file. Non-files, oversized files, and
 * byte-count mismatches return undefined. An optional predicate can reject the opened file. Filesystem and decoding errors propagate.
 */
export function readBoundedGitMetadata(
  path: string,
  maxBytes: number,
  verifyFile?: (info: Stats) => boolean,
): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes || verifyFile?.(info) === false) return undefined;
    const bytes = readExactDescriptorBytes(fd, info.size);
    return bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
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
