/** Read the exact inspected byte length from an already-open descriptor (PRD §8.2). */
import { readSync } from "node:fs";

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
