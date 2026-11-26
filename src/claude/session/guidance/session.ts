/**
 * Holds a Claude `Stop` while guidance is still queued behind the turn it ends (PRD §6.5,
 * C-HOOK-24). The held `hook_turn_ended` is an ignored status decision, and so is Claude's idle
 * composer while guidance is still being screened or unheard; each names what it waits on. The
 * next `Stop`, the idle composer once nothing is undecided, guidance that is all blocked or
 * unheard, or the hang limit ends the turn. The last two name their cause on the decision that
 * marks the session ready, and the hang limit also reports `queued_turn_unconfirmed`.
 */
import { runContained } from "../../../core/contained.ts";
import { queuedTurnUnconfirmedWarning } from "../../../core/warnings/queued-turn.ts";
import type { StatusDecision, StatusEvidenceKind } from "../../../runtime/status-evidence.ts";
import type { ClaudeHookEvent } from "../../hooks/index.ts";
import type { ClaudeHookEventName } from "../../hooks/names.ts";
import { claudePromptId } from "../../hooks/prompt-id.ts";
import { ClaudeTurnEndSession } from "../turn-end-hold.ts";
import {
  ClaudeGuidanceLedger,
  type GuidanceAnswer,
  type GuidanceHold,
  type GuidanceRelease,
} from "./ledger.ts";

/** Why a hold ignores evidence that would mark the session ready. */
const holdReasons: Readonly<Record<GuidanceHold, string>> = {
  queued: "Claude runs the guidance queued at this Stop as a new turn",
  screening: "a UserPromptSubmit handler is still screening guidance",
  unheard: "input written into the turn has not fired its UserPromptSubmit",
};
/** What ended a hold that neither the next `Stop` nor Claude's idle composer ended. */
const releaseReasons: Readonly<Record<GuidanceRelease, string>> = {
  blocked: "the guidance held at the Stop was blocked",
  unheard: "input written into the turn never fired its UserPromptSubmit",
  hung: "no queued turn ended within the hang limit",
};
/** Hooks after which Claude makes its next model request, delivering allowed guidance. */
const toolEnds: ReadonlySet<ClaudeHookEventName> = new Set<ClaudeHookEventName>([
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
]);

export abstract class ClaudeGuidanceSession extends ClaudeTurnEndSession {
  private ledger: ClaudeGuidanceLedger | undefined;

  /**
   * Built on first use, because the base constructor wires callbacks into methods this class
   * overrides before this class's fields are initialized.
   */
  private get guidance(): ClaudeGuidanceLedger {
    if (this.ledger === undefined) {
      const ledger = new ClaudeGuidanceLedger((cause) => this.releaseHeldStop(cause));
      this.closing.signal.addEventListener("abort", () => ledger.dispose(), { once: true });
      this.ledger = ledger;
    }
    return this.ledger;
  }

  /** Records a hook as it arrives; a queued `UserPromptSubmit` returns its handler's answer. */
  recordGuidanceHook(event: ClaudeHookEvent): GuidanceAnswer | undefined {
    if (toolEnds.has(event.hook_event_name)) this.guidance.toolBoundary();
    if (event.hook_event_name !== "UserPromptSubmit") return undefined;
    return this.guidance.heard(claudePromptId(event["prompt_id"]));
  }

  /** `StopCompletion` reports each physical submission Elwood makes inside a Claude turn. */
  noteMidTurnSubmission(): void {
    this.guidance.written();
  }

  /** An unblocked `Stop`. One that a newer submission superseded only updates the ledger. */
  submitStop(promptId: string | undefined, superseded: boolean): void {
    const hold = this.guidance.holdStop(promptId);
    if (superseded) return;
    if (hold === undefined) this.submitEvidence("hook_turn_ended");
    else this.statusEngine.submit("hook_turn_ended", { holdReason: holdReasons[hold] });
  }

  override submitEvidence(
    kind: StatusEvidenceKind,
    workingVisible?: boolean,
    cause?: string,
  ): StatusDecision {
    const hold = kind === "rendered_turn_ended" ? this.guidance.holdRenderedEnd() : undefined;
    if (hold !== undefined)
      return this.statusEngine.submit(kind, { holdReason: holdReasons[hold] });
    return super.submitEvidence(kind, workingVisible, cause);
  }

  /** Runs from the ledger's timers and hook answers, so a throwing observer stays contained. */
  private releaseHeldStop(cause: GuidanceRelease): void {
    if (cause === "hung") this.emitWarningLater(queuedTurnUnconfirmedWarning(this.elwoodSessionId));
    runContained(() => void this.submitEvidence("hook_turn_ended", false, releaseReasons[cause]));
  }
}
