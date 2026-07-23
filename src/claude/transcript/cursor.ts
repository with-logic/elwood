/**
 * Bounded, per-path incremental reader for a Claude transcript JSONL file.
 * Implements PRD §5.4 (C-CLAUDE-15). The forward bounded-read core is shared with
 * Codex (core/transcript/cursor); Claude extends it with a backward baseline-tail
 * scan (recovering just the current turn already on disk) and an async `needsScan`.
 */

import { stat } from "node:fs/promises";
import { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import { scanBaselineTail } from "./baseline.ts";
import { fileSize } from "./cursor-io.ts";

export type { ChunkRead, DiscardTransition, TakenLines } from "../../core/transcript/cursor.ts";
export { resetByteReaderForTests, setByteReaderForTests } from "./cursor-io.ts";

/**
 * The forward bounded cursor plus Claude-only baseline-tail recovery. A new cursor
 * starts at the file's CURRENT end (its history is NOT replayed); `baselineTail()`
 * recovers just the current turn already-on-disk when the first hook to carry the
 * path is a turn-boundary hook.
 */
export class TranscriptCursor extends BoundedTranscriptCursor {
  // The current (final) turn already on disk (the Stop-first edge). Delegates to
  // the bounded backward scan (`scanBaselineTail`): UTF-8-seam-safe, linear, and —
  // when the turn is larger than the cap — recovering the in-window committed
  // records rather than silently dropping the whole turn (§5.4, C-CLAUDE-15).
  // Returns the joined tail text PLUS whether the scan hit its cap (`truncated`)
  // and, if so, the bytes beyond the window that were NOT recovered — so the caller
  // can surface that loss as a bounded, content-free drop instead of dropping it
  // silently.
  baselineTail(): { text: string; truncated: boolean; droppedBytes: number } {
    const size = fileSize(this.path);
    const tail = scanBaselineTail(this.path, size);
    return {
      text: tail.lines.join("\n"),
      truncated: tail.truncated,
      droppedBytes: tail.unrecoveredBytes,
    };
  }

  // True when the file changed size (grew OR truncated) since the last read, via
  // an ASYNC stat so an idle poll does no sync fs work on the loop (§9.2).
  async needsScan(): Promise<boolean> {
    const size = (await stat(this.path)).size;
    return size !== this.offset;
  }
}
