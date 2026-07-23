/**
 * Bounded filesystem primitives for the Claude transcript cursor.
 * Implements PRD §5.4 (C-CLAUDE-15). The forward primitives (stat, forward range
 * read, the injectable byte seam) are shared with Codex via core/transcript/cursor-io;
 * this file adds the Claude-only BACKWARD block read used by the baseline-tail scan,
 * funneling through the SAME shared byte seam so a test still controls all reads.
 */

import { readBytes } from "../../core/transcript/cursor-io.ts";
import { completeUtf8Length } from "../../runtime/probe.ts";

export {
  type ByteReader,
  byteLen,
  fileSize,
  type RangeRead,
  readBytes,
  readRange,
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../core/transcript/cursor-io.ts";

/** One backward block: its decoded text and the byte offset it actually begins at. */
export type BackwardBlock = { readonly text: string; readonly start: number };

// Max continuation bytes that can lead a code point split at a block seam (a
// 4-byte code point has at most 3 continuation bytes).
const maxLeadingContinuation = 3;

// Reads the block `[start, end)` for a BACKWARD scan, decoding intact even when
// `start` splits a multibyte code point at the block seam. When `start > 0` we
// over-read up to 3 bytes before `start` so the split code point's lead byte is
// present, then drop only the raw leading bytes that belong to the code point
// straddling `start` — so no U+FFFD is ever produced at the seam (C-CLAUDE-15).
// The returned `start` is the byte offset the decoded text actually begins at,
// which the caller uses as the next step's `end` (no double-count, no gap).
export function readBackwardBlock(path: string, start: number, end: number): BackwardBlock {
  const over = Math.min(start, maxLeadingContinuation);
  const readStart = start - over;
  const bytes = readBytes(path, readStart, end - readStart);
  const skip = over === 0 ? 0 : leadingSkip(bytes, over);
  const complete = completeUtf8Length(bytes.subarray(skip));
  return { text: bytes.toString("utf8", skip, skip + complete), start: readStart + skip };
}

// Raw bytes to drop from the front of a backward block so decoding begins on a
// COMPLETE code point at (or after) the original `start`. `over` extra bytes were
// prepended so any code point straddling `start` is fully present. The original
// `start` sits at buffer index `over`; if the byte there is a UTF-8 continuation
// byte (0b10xxxxxx), the code point began earlier and straddles the seam, so skip
// forward past every continuation byte to the next code-point boundary (which may
// land after `over`). Otherwise `start` already begins a code point: drop the
// `over` pre-bytes exactly.
function leadingSkip(bytes: Buffer, over: number): number {
  let skip = over;
  while (skip < bytes.length && (bytes[skip] as number) >= 0x80 && (bytes[skip] as number) < 0xc0) {
    skip++;
  }
  return skip;
}
