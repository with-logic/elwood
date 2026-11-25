/**
 * Claude mounts a post-turn dialog, such as its auto-mode setup offer, when the turn's query
 * ends, and takes keys from then on. It paints the dialog only with the frame that clears the
 * turn's working indicator, after Elwood's own `Stop` hook has reported `ready`. Queued input
 * after a turn therefore waits for that frame, so the dialog's hold can see the dialog first.
 * Implements PRD §5.3 and C-ATTN-10.
 */
import { readScreenFacts } from "../../core/screen-facts.ts";
import type { StatusDecision, StatusEvidenceKind } from "../../runtime/status-evidence.ts";
import { cachedLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeScreenFactTable } from "../screen-table.ts";
import { ClaudeQuestionsSession } from "./questions.ts";

/** Longest a working indicator that outlives its turn delays queued input (C-ATTN-10). */
export const turnEndPaintLimitMs = 5_000;

/** From a turn's `Stop` until a rendered frame stops showing that turn working. */
export class ClaudeTurnEndHold {
  private endedAt: number | undefined;
  private readonly terminal: () => ElwoodTerminal;
  private readonly now: () => number;
  constructor(terminal: () => ElwoodTerminal, now: () => number = Date.now) {
    this.terminal = terminal;
    this.now = now;
  }
  /** The turn's `Stop` moved the session to `ready`. */
  turnEnded(): void {
    this.endedAt = this.now();
  }
  holds(): boolean {
    if (this.endedAt === undefined) return false;
    if (this.workingVisible() && this.now() - this.endedAt < turnEndPaintLimitMs) return true;
    this.endedAt = undefined;
    return false;
  }
  private workingVisible(): boolean {
    const terminal = this.terminal();
    const frame = { text: cachedLiveSnapshot(terminal).text, title: terminal.title };
    return readScreenFacts(claudeScreenFactTable, frame).facts.working_visible;
  }
}

/** Every queued Claude writer, paste and Enter alike, also waits for the turn's end frame. */
export abstract class ClaudeTurnEndSession extends ClaudeQuestionsSession {
  private turnEndHold: ClaudeTurnEndHold | undefined;
  private get turnEnd(): ClaudeTurnEndHold {
    this.turnEndHold ??= new ClaudeTurnEndHold(() => this.terminal);
    return this.turnEndHold;
  }
  override submitEvidence(kind: StatusEvidenceKind, workingVisible = false): StatusDecision {
    const decision = super.submitEvidence(kind, workingVisible);
    if (kind === "hook_turn_ended" && decision.to === "ready") this.turnEnd.turnEnded();
    return decision;
  }
  protected override queuedInputBlocked(): boolean {
    return super.queuedInputBlocked() || this.turnEnd.holds();
  }
}
