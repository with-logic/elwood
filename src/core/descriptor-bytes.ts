/** Read the exact inspected byte length from an already-open descriptor (PRD §5.5 and §8.2). */
import { readSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/**
 * Read from offset zero and return undefined if the descriptor has a different length.
 * Read errors propagate to the caller, which owns and closes the descriptor.
 */
export function readExactDescriptorBytes(fd: number, expectedBytes: number): Buffer | undefined {
  // One extra byte detects growth after fstat. A short positive read isn't EOF.
  const buffer = Buffer.allocUnsafe(expectedBytes + 1);
  let count = 0;
  while (count < buffer.length) {
    const read = readSync(fd, buffer, count, buffer.length - count, count);
    if (read === 0) break;
    count += read;
  }
  return count === expectedBytes ? buffer.subarray(0, count) : undefined;
}

/** Read the inspected length asynchronously and stop issuing reads after cancellation. */
export async function readExactDescriptorBytesAsync(
  fd: FileHandle,
  expectedBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | undefined> {
  // One extra byte detects growth after stat. A positive short read is not EOF.
  const buffer = Buffer.allocUnsafe(expectedBytes + 1);
  let count = 0;
  while (count < buffer.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await fd.read(buffer, count, buffer.length - count, count);
    if (bytesRead === 0) break;
    count += bytesRead;
  }
  return count === expectedBytes ? buffer.subarray(0, count) : undefined;
}
