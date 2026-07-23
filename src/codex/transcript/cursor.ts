/**
 * Bounded incremental reader for one Codex transcript JSONL file.
 * Codex uses the shared bounded cursor verbatim (no backward baseline-tail scan and
 * no async needsScan), so this re-exports the core cursor under the adapter's name.
 * Implements PRD §7A/§5.4. See core/transcript/cursor.
 */

export {
  BoundedTranscriptCursor as CodexTranscriptCursor,
  type ChunkRead,
  type DiscardTransition,
  type TakenLines,
} from "../../core/transcript/cursor.ts";
