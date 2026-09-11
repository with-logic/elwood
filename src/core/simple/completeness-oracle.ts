/**
 * The completeness oracle for one ergonomic turn (PRD §5.8, C-API-48/53): a bounded rolling
 * window of the turn's assistant text and the `Stop` hook's expected final text. The turn is
 * "caught up" once the collected text CONTAINS the expected text. Extracted from TurnGate so
 * the text-matching stays a self-contained, individually testable unit under the size cap.
 */

// Extra tail (chars) kept beyond the expected length so a match straddling a fragment boundary
// is not missed; only the RECENT tail is needed, so `collected` stays bounded.
const ORACLE_TAIL_SLACK = 4096;
/**
 * Cap on the agent-controlled expected-text length (chars) so a hostile huge
 * `last_assistant_message` cannot size the window without limit; a suffix match still signals
 * completeness. Exported so the boundary test cites the real bound rather than a mirrored copy.
 */
export const expectedTextMax = 1024 * 1024;

export class CompletenessOracle {
  private collected = ""; // transcript assistant text seen so far (a bounded rolling tail)
  private expected: string | undefined; // Stop hook's last_assistant_message, trimmed + capped

  /** Append transcript assistant text, retaining only the tail the oracle could still match. */
  observeText(text: string): void {
    this.collected = (this.collected + text).slice(-this.window());
  }

  /**
   * Install (or clear) the expected final text. Returns `true` if a NON-EMPTY oracle was just
   * installed — the caller must then cancel any quiet-window fallback, since the promised text now
   * governs completion. An empty/blank value clears the oracle (→ quiet-window settle). Only a
   * turn-BOUNDARY signal reaches here: the gate drops non-boundary hooks before this call.
   */
  expectText(text: string): boolean {
    const trimmed = text.trim();
    // Cap the agent-controlled expected text so the rolling window stays bounded; its SUFFIX still
    // appears in the transcript, so a suffix match is a valid completeness signal.
    this.expected = trimmed ? trimmed.slice(-expectedTextMax) : undefined;
    return this.expected !== undefined;
  }

  /** Whether a (non-empty) expected text is installed — i.e. the oracle governs completion. */
  get hasExpected(): boolean {
    return this.expected !== undefined;
  }

  /** Whether the collected transcript text has caught up to the expected text. */
  get matched(): boolean {
    return this.expected !== undefined && this.collected.includes(this.expected);
  }

  // Before the oracle is installed, retain enough tail for the LARGEST expected text that could
  // still arrive (a lagging Stop hook means pre-`expectText` text would otherwise be truncated
  // below the later expected length and never match); once known, shrink to that length + slack.
  private window(): number {
    return (this.expected?.length ?? expectedTextMax) + ORACLE_TAIL_SLACK;
  }
}
