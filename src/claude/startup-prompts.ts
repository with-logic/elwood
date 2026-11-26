/**
 * Answers Claude first-party prompts that block embedded readiness or later input:
 * workspace/skill/plugin/MCP trust (via the allowlisted TrustPromptResponder), the
 * browser-tools prompt, and the auto-mode setup offer that can follow a turn.
 * Implements PRD §5.1, §5.3, C-CLAUDE-10, C-CLAUDE-11, C-CLAUDE-14, C-CLAUDE-16,
 * C-CLAUDE-22, C-CLAUDE-26, C-CLAUDE-27 and C-CLAUDE-29.
 */

import type { InputTerminal } from "../core/input/abort.ts";
import {
  type AutomationWriteResult,
  guardedNonTrustAutomationWrite,
  type NonTrustAutomationWriter,
} from "../core/startup/barrier.ts";
import type { SettledStartupOutcome, StartupWriteCompletion } from "../core/startup/write.ts";
import { trustGateVisible } from "../core/trust/blocking.ts";
import type { TrustClearance } from "../core/trust/clearance.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust/responder.ts";
import {
  ClaudeAutoModeOfferDecliner,
  type DeclineWriter,
  declineKey,
} from "./auto-mode/decline.ts";
import { isClaudeAutoModeOfferMenu } from "./auto-mode/offer.ts";
import { type ProbeTrustOptions, probeTrustPolicy } from "./probe-trust.ts";
import { claudeTrustClearance } from "./screen-table.ts";

export class ClaudeStartupPromptResponder {
  private readonly trust: TrustPromptResponder<"claude">;
  private browserDeclineLatched = false;
  private readonly lifetime = new AbortController();
  private readonly autoModeOfferDecliner = new ClaudeAutoModeOfferDecliner(this.lifetime.signal);
  private readonly onWorkspaceTrustTakeover: (() => void) | undefined;

  constructor(
    autotrust: boolean,
    onStateChange?: () => void,
    clearance: TrustClearance = claudeTrustClearance,
    onWorkspaceTrustTakeover?: () => void,
    probeTrust?: ProbeTrustOptions,
  ) {
    this.onWorkspaceTrustTakeover = onWorkspaceTrustTakeover;
    const policy = probeTrust && probeTrustPolicy(probeTrust);
    this.trust = new TrustPromptResponder("claude", clearance, autotrust, {
      onStateChange: () => {
        policy?.onStateChange(this.trust.blockedPrompt);
        onStateChange?.();
      },
      claimCallerOwnership: policy?.claim,
    });
  }

  get blockedPrompt() {
    return this.trust.blockedPrompt;
  }

  get humanOwnedPrompt() {
    return this.trust.humanOwnedPrompt;
  }

  /**
   * Session closing owns cancellation for NON-TRUST automation too, not just for trust
   * attempts. After `dispose()` no new decline is attempted, and a decline already in
   * flight settles `cancelled`, so nothing writes to a dead PTY and neither
   * `startup_prompt` nor `startup_prompt_write_failed` is emitted after stop/kill/exit
   * (C-CLAUDE-22).
   */
  dispose(): void {
    this.lifetime.abort();
    this.trust.dispose();
  }

  /**
   * Raw caller input owns the trust gate on screen (C-TRUST-01) and the auto-mode offer
   * (C-CLAUDE-27).
   */
  callerInput(): void {
    const previous = this.trust.humanOwnedPrompt;
    this.trust.callerInput();
    this.autoModeOfferDecliner.callerInput();
    const current = this.trust.humanOwnedPrompt;
    if (current === "workspace_trust" && current !== previous) this.onWorkspaceTrustTakeover?.();
  }

  get inputBlocking(): boolean {
    return this.trust.inputBlocking;
  }

  /** Lets the guarded writer abandon a write that is still parked on render settlement. */
  get closing(): boolean {
    return this.lifetime.signal.aborted;
  }

  /** Interrupt the observation budget as soon as session disposal begins. */
  get closingSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  /**
   * `write` answers trust; `writeAutomation` (default `write`) handles other prompts, where a
   * trust gate must withhold unrelated automated keys. Live adapters must supply
   * `readSettledFrame` from `settledLiveSnapshot`, returning undefined for pending rendering,
   * synchronized output, or render failure. Trust reads it. The auto-mode offer's decline runs
   * only when both it and `writeAutomation` are supplied, since only the guarded writer can
   * withhold an Esc after caller input. The fallback to `readFrame` preserves static/direct
   * callers; a snapshot-only reader must not replace the settlement-aware reader in a live
   * session.
   */
  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
    writeAutomation?: DeclineWriter,
    readSettledFrame?: () => string | undefined,
  ): readonly SettledStartupOutcome<"claude">[] {
    const settled: SettledStartupOutcome<"claude">[] = [];
    if (this.closing) return settled;
    const trust = this.trust.handle(screenText, write, readSettledFrame ?? readFrame);
    if (trust?.kind === "attempted") {
      settled.push({ outcome: { kind: "attempted", ...trust.automation }, settled: trust.settled });
    } else if (trust?.kind === "option_pending") {
      settled.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    if (
      !this.browserDeclineLatched &&
      browserToolsDeclinable(screenText) &&
      !trustGateVisible(screenText, "claude") // a trust gate is never declined blind (C-TRUST-01)
    ) {
      // Escape is the documented decline and needs no option number, so option order cannot
      // break it. Latch before writing; a rejected live write stays retryable on a later
      // frame, and disposal cancels retries and diagnostics for good.
      this.browserDeclineLatched = true;
      // A WITHHELD write never reached the PTY, so it claims nothing: un-latch and settle as
      // `cancelled`, with no activity, so a later frame retries only while still live.
      const writeSettled = Promise.resolve(
        (writeAutomation ?? write)(declineKey, browserToolsDeclinable),
      )
        .then((result): StartupWriteCompletion => {
          // Disposal DURING the write wins: the session is gone, so report neither a success
          // activity nor a write-failure warning for it (C-CLAUDE-22).
          if (this.closing) return "cancelled";
          if (result !== "withheld") return "answered";
          this.browserDeclineLatched = false;
          return "cancelled";
        })
        .catch((error: unknown): StartupWriteCompletion => {
          if (this.closing) return "cancelled";
          this.browserDeclineLatched = false;
          throw error;
        });
      settled.push({
        outcome: { kind: "attempted", prompt: "browser_tools", input: "esc" },
        settled: writeSettled,
      });
    }
    // Its decline is verified on settled frames, which only a live session can read.
    const offer =
      readSettledFrame &&
      writeAutomation &&
      this.autoModeOfferDecliner.handle(screenText, writeAutomation, readSettledFrame);
    if (offer) settled.push(offer);
    return settled;
  }
}

/**
 * The Claude non-trust automation barrier. A decline is only correct while its own
 * prompt is still on screen: if the prompt cleared during settlement, an Escape would
 * land in whatever replaced it (a composer, clearing staged text), so it is withheld.
 * A writer may narrow that to one prompt for a single write.
 */
export function guardedClaudeAutomationWrite(
  terminal: InputTerminal,
  write: NonTrustAutomationWriter,
  readFrame: () => string,
  cancelled: () => boolean = () => false,
  signal?: AbortSignal,
): (input: string, stillValid?: (frameText: string) => boolean) => Promise<AutomationWriteResult> {
  return guardedNonTrustAutomationWrite(
    terminal,
    write,
    readFrame,
    "claude",
    (frameText) => browserToolsPromptVisible(frameText) || isClaudeAutoModeOfferMenu(frameText),
    cancelled,
    signal,
  );
}

export function browserToolsPromptVisible(text: string): boolean {
  return /use my browser/i.test(text) && /keep browser tools off/i.test(text);
}

/**
 * The browser-tools decline acts only without the auto-mode menu on the frame, which owns
 * Escape while it shows: the browser-tools phrases can also appear in the transcript.
 */
function browserToolsDeclinable(text: string): boolean {
  return browserToolsPromptVisible(text) && !isClaudeAutoModeOfferMenu(text);
}
