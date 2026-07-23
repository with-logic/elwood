/**
 * Bounded filesystem primitives for the Codex transcript cursor.
 * Codex has only forward reads (no backward baseline-tail scan), so this is a thin
 * re-export of the shared core primitives (PRD §7A/§5.4). See core/transcript/cursor-io.
 */

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
