/**
 * Holds a Claude `Stop` while guidance is still queued behind the turn it ends (PRD §6.5,
 * C-HOOK-24). The held `hook_turn_ended` is an ignored status decision, and so is Claude's idle
 * composer while guidance is still being screened or unheard. The queued turn's `Stop`, the idle
 * composer once nothing is undecided, guidance that is all blocked or unheard, or the hang limit
 * ends the turn; the hang limit also reports `queued_turn_unconfirmed`.
 */
import { runContained } from "../../core/contained.ts";
import { queuedTurnUnconfirmedWarning } from "../../core/warnings/queued-turn.ts";
import type { StatusDecision, StatusEvidenceKind } from "../../runtime/status-evidence.ts";
import { claudePromptId } from "../hooks/prompt-id.ts";
import { ClaudeGuidanceLedger, type GuidanceAnswer } from "./guidance-ledger.ts";
import { ClaudeTurnEndSession } from "./turn-end-hold.ts";

const heldBy = "Claude runs the guidance queued at this Stop as a new turn";
/** Hooks after which Claude makes its next model request, delivering allowed guidance. */
const toolEnds: ReadonlySet<unknown> = new Set([
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
]);

export abstract class ClaudeGuidanceSession extends ClaudeTurnEndSession {
  private ledger: ClaudeGuidanceLedger | undefined;

  /** The guidance queued behind Claude's turns, which the hook handler records. */
  get guidance(): ClaudeGuidanceLedger {
    if (this.ledger === undefined) {
      const ledger = new ClaudeGuidanceLedger((hung) => this.releaseHeldStop(hung));
      this.closing.signal.addEventListener("abort", () => ledger.dispose(), { once: true });
      this.ledger = ledger;
    }
    return this.ledger;
  }

  /** Records a hook as it arrives; a queued `UserPromptSubmit` returns its handler's answer. */
  guidanceHook(event: { readonly [key: string]: unknown }): GuidanceAnswer | undefined {
    const name = event["hook_event_name"];
    if (toolEnds.has(name)) this.guidance.toolBoundary();
    if (name !== "UserPromptSubmit") return undefined;
    return this.guidance.heard(claudePromptId(event["prompt_id"]));
  }

  /** `StopCompletion` reports each physical submission Elwood makes inside a Claude turn. */
  noteMidTurnSubmission(): void {
    this.guidance.written();
  }

  /** An unblocked `Stop`. One that a newer submission superseded only updates the ledger. */
  submitStop(promptId: string | undefined, superseded: boolean): void {
    const held = this.guidance.stopHolds(promptId);
    if (superseded) return;
    if (held) this.statusEngine.submit("hook_turn_ended", { heldBy });
    else this.submitEvidence("hook_turn_ended");
  }

  override submitEvidence(kind: StatusEvidenceKind, workingVisible?: boolean): StatusDecision {
    if (kind === "rendered_turn_ended" && !this.guidance.renderedEndReleases())
      return this.statusEngine.submit(kind, { heldBy });
    return super.submitEvidence(kind, workingVisible);
  }

  /** Runs from the ledger's timers and hook answers, so a throwing observer stays contained. */
  private releaseHeldStop(hung: boolean): void {
    if (hung) {
      const warning = queuedTurnUnconfirmedWarning(this.elwoodSessionId);
      queueMicrotask(() => runContained(() => this.emitWarnings([warning])));
    }
    runContained(() => void this.submitEvidence("hook_turn_ended"));
  }
}
