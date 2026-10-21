/** Private native-frame and guarded-I/O contract (PRD §4.1). */
import type { TerminalSnapshot } from "../../terminal/headless.ts";

export type QuestionFrame = TerminalSnapshot & {
  /** Zero-based row in snapshot lines; cursorY=3, baseY=10, viewportY=8 gives row5. */
  readonly cursorRow: number;
  /** Live completed frames supply visibility; partial/older captures may omit it.
   * Unknown visibility never proves that a composer is clear. */
  readonly cursorVisible?: boolean;
};
export type QuestionIo = {
  readonly signal: AbortSignal;
  frame(): QuestionFrame | undefined;
  /** Recheck the predicate after completed renders or resize; abort rejects.
   * After a write, require completed output progress before accepting a frame. */
  wait(test: (frame: QuestionFrame) => boolean): Promise<QuestionFrame>;
  /** Await only the send; callers must wait between state-changing writes. */
  write(input: string, matchesBeforeWrite: (frame: QuestionFrame) => boolean): Promise<void>;
};
