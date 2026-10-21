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
  wait(test: (frame: QuestionFrame) => boolean): Promise<QuestionFrame>;
  /** After a state-changing write, await native progress before writing again. */
  write(input: string, matchesBeforeWrite: (frame: QuestionFrame) => boolean): Promise<void>;
};
