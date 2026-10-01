/** Reset rendered turn evidence at physical caller submission (PRD §5.3, C-TURN-04). */
import type { RenderedObservers } from "../../core/rendered-observers.ts";
import { readScreenFacts } from "../../core/screen-facts.ts";
import {
  captureRenderProgress,
  currentRenderedFrame,
  hasUnknownOrNonPristineOutput,
} from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { StopCompletion } from "./stop-completion.ts";

export function bindTurnSubmission<
  Session extends { readonly terminal: ElwoodTerminal; readonly stopCompletion: StopCompletion },
>(session: Session, observers: RenderedObservers): Session {
  session.stopCompletion.bindRenderedReset(() => {
    const hasFreshFrame = captureRenderProgress(session.terminal);
    const frame = currentRenderedFrame(session.terminal);
    // A missing baseline is conservative uncertainty, not observed banner visibility.
    // Only a pristine terminal proves absence without a completed frame.
    const ignoreRetainedInterrupt = frame
      ? readScreenFacts(observers.table, { text: frame.text, title: session.terminal.title }).facts
          .interrupt_complete_visible
      : hasUnknownOrNonPristineOutput(session.terminal);
    return () => {
      observers.turn.submitted(hasFreshFrame, ignoreRetainedInterrupt);
    };
  });
  return session;
}
