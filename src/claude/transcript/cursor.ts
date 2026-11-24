/**
 * Bounded, per-path incremental reader for a Claude transcript JSONL file.
 * Implements PRD §5.4 / §5.7 (C-CLAUDE-15, C-CLAUDE-24). The forward bounded-read core is
 * shared with Codex. Claude adds current-turn replay, a bounded initial prompt
 * lookup against the registered file version, and an async idle gate.
 */

import { stat } from "node:fs/promises";
import { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import { statIfPresent } from "../../core/transcript/cursor-io.ts";
import type { ChunkBudget } from "../../core/transcript/drain.ts";
import { type BaselinePrompt, scanBaselineTail } from "./baseline.ts";
import { InitialClaudePrompt } from "./initial-prompt.ts";

export type { ChunkRead, TakenLines } from "../../core/transcript/cursor.ts";
export { resetByteReaderForTests, setByteReaderForTests } from "./cursor-io.ts";

/**
 * Forward observation starts at the file's current end. Claude uses the baseline
 * tail to seed native turn identity or replay the current turn. Initial prompt
 * text recovery separately verifies the registered file version.
 */
export class TranscriptCursor extends BoundedTranscriptCursor {
  private readonly initial: InitialClaudePrompt;
  private retryInitial: (() => void) | undefined;
  constructor(path: string) {
    const registration = statIfPresent(path);
    super(path, { size: registration?.size });
    this.initial = new InitialClaudePrompt(registration);
  }

  takeLatestInitialPrompt(pendingToken: object) {
    return this.initial.take(this.path, pendingToken);
  }

  recordInitialLookupReadFailure(pendingToken: object): void {
    this.initial.recordAttempt(pendingToken);
  }

  scheduleInitialRetry(retry: () => void): void {
    this.retryInitial ??= retry;
  }

  runInitialRetry(budget: ChunkBudget): void {
    const retry = this.retryInitial;
    if (!retry) return;
    this.retryInitial = undefined;
    budget.chunks -= 1;
    retry();
  }

  /** Read only within the EOF baseline; callers contain filesystem failures with the guard. */
  baselinePrompt(): BaselinePrompt | undefined {
    return scanBaselineTail(this.path, this.offset).prompt;
  }

  // The current (final) turn already on disk (the Stop-first edge). Delegates to
  // the bounded backward scan (`scanBaselineTail`). A scan limit or unreadable
  // seam leaves `truncated` and the unrecovered byte count even when complete
  // later records can still be recovered (§5.4, C-CLAUDE-15).
  // Sized under the existence policy: a file not created yet has no tail, and one removed
  // after it existed throws for the fs guard rather than reading as empty (C-CLAUDE-24).
  baselineTail(): { text: string; truncated: boolean; droppedBytes: number } {
    const size = this.liveSize() ?? 0;
    const tail = scanBaselineTail(this.path, size);
    return {
      text: tail.lines.join("\n"),
      truncated: tail.truncated,
      droppedBytes: tail.unrecoveredBytes,
    };
  }

  // True when the file changed size (grew OR truncated) since the last read, via
  // an ASYNC stat so an idle poll does no sync fs work on the loop (§9.2). A file not
  // created yet has nothing to scan; any other failure, including ENOENT after the file
  // existed, rejects so the fs guard reports it.
  async needsScan(): Promise<boolean> {
    try {
      return this.sawSize((await stat(this.path)).size) !== this.offset;
    } catch (error) {
      this.rethrowUnlessUncreated(error);
      return false;
    }
  }
}
