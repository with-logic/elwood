/**
 * Claude mounts its auto-mode setup offer when a query ends in auto mode, and the offer takes
 * keys from then on. Elwood only sees it once it paints, which can follow the session's own
 * `ready`. So after a turn ends in auto mode, queued Claude input waits for a fresh frame that
 * has stayed unchanged for a settle window and shows Claude's composer with no working
 * indicator and no dialog, for a bounded time. Implements PRD §5.3 and C-ATTN-10.
 */
import { readScreenFacts } from "../../core/screen-facts.ts";
import type { StatusDecision, StatusEvidenceKind } from "../../runtime/status-evidence.ts";
import { cachedLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeScreenFactTable } from "../screen-table.ts";
import { ClaudeQuestionsSession } from "./questions.ts";

/** How long the end frame must stay unchanged: past the offer's mount-to-paint window. */
export const turnEndSettleMs = 500;
/** Longest queued input waits for that frame after the turn ends (C-ATTN-10). */
export const turnEndPaintLimitMs = 5_000;

/** From a turn's end until a stable, idle, dialog-free composer frame, or the limit. */
export class ClaudeTurnEndHold {
  private armedAt: number | undefined;
  private frame: string | undefined;
  private changedAt = 0;
  private readonly terminal: () => ElwoodTerminal;
  private readonly now: () => number;
  constructor(terminal: () => ElwoodTerminal, now: () => number = Date.now) {
    this.terminal = terminal;
    this.now = now;
  }
  arm(): void {
    this.armedAt = this.now();
    this.frame = undefined;
  }
  get armed(): boolean {
    return this.armedAt !== undefined;
  }
  /** Ends the hold; `false`, so that `holds()` can return it. */
  release(): false {
    this.armedAt = undefined;
    return false;
  }
  holds(): boolean {
    if (this.armedAt === undefined) return false;
    const now = this.now();
    if (now - this.armedAt >= turnEndPaintLimitMs) return this.release();
    const terminal = this.terminal();
    const frame = { text: cachedLiveSnapshot(terminal).text, title: terminal.title };
    const key = `${frame.title}\n${frame.text}`;
    // Only frames read after the hold started count, and any change restarts the window.
    if (key !== this.frame) {
      this.frame = key;
      this.changedAt = now;
    }
    const { facts } = readScreenFacts(claudeScreenFactTable, frame);
    const idle = facts.composer_visible && !facts.working_visible && !facts.blocking_prompt_visible;
    return idle && now - this.changedAt >= turnEndSettleMs ? this.release() : true;
  }
}

/** What ends a turn: its `Stop`, or its rendered end, which an interrupted turn has too. */
const turnEndEvidence: ReadonlySet<StatusEvidenceKind> = new Set([
  "hook_turn_ended",
  "rendered_turn_ended",
]);

/** Claude's footer mode item while auto mode is on, the only mode that offers its setup. */
const autoModeFooter = /⏵⏵ auto mode on/;

/** Every queued Claude writer, paste and Enter alike, also waits for a stable end frame. */
export abstract class ClaudeTurnEndSession extends ClaudeQuestionsSession {
  private turnEndHold: ClaudeTurnEndHold | undefined;
  private get turnEnd(): ClaudeTurnEndHold {
    this.turnEndHold ??= new ClaudeTurnEndHold(() => this.terminal);
    return this.turnEndHold;
  }
  override submitEvidence(kind: StatusEvidenceKind, workingVisible = false): StatusDecision {
    // Resumed work ends the last turn's hold, so input for the running turn is not held.
    if (kind === "rendered_turn_started" || (kind === "blocking_prompt_cleared" && workingVisible))
      this.turnEnd.release();
    // Reaching `ready` reopens the queue even when a status observer throws, so the hold is
    // armed first. A turn end seen twice, by its `Stop` and by its rendered end, keeps the
    // first hold. One while `blocked`, by a dismissed dialog, holds past that dialog.
    else if (
      turnEndEvidence.has(kind) &&
      !(this.status === "ready" && this.turnEnd.armed) &&
      this.autoModeOffered()
    )
      this.turnEnd.arm();
    return super.submitEvidence(kind, workingVisible);
  }
  /** Claude mounts the offer only in auto mode: as launched, or as its footer shows now. */
  private autoModeOffered(): boolean {
    if (this.record.claude.launch?.permissionMode === "auto") return true;
    return autoModeFooter.test(cachedLiveSnapshot(this.terminal).text);
  }
  protected override queuedInputBlocked(): boolean {
    return super.queuedInputBlocked() || this.turnEnd.holds();
  }
}
