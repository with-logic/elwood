/**
 * A Claude startup-prompt responder with the model probe's trust policy, and what it does with
 * a frame, for the probe's policy tests (PRD §5.3, C-CLAUDE-26, C-CLAUDE-29).
 */
import { vi } from "vitest";
import type { ProbeTrustRefusal } from "../../src/claude/probe-trust.ts";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import type { TrustPromptIdFor } from "../../src/core/trust/prompts.ts";

/** A responder with the probe's policy, recording its refusals, writes, and state changes. */
export function probeResponder(canDiscloseHooks = true) {
  const refusals: ProbeTrustRefusal[] = [];
  const stateChanges = vi.fn();
  const responder = new ClaudeStartupPromptResponder(
    true,
    stateChanges,
    claudeTrustClearance,
    undefined,
    { canDiscloseHooks, onRefused: (reason) => refusals.push(reason) },
  );
  const writes: string[] = [];
  const show = (frame: string) =>
    responder.handle(
      frame,
      (input) => {
        writes.push(input);
      },
      () => frame,
    );
  return { responder, show, refusals, writes, stateChanges };
}

/** What the probe does with `frame`: its outcomes, writes, refusals, and the prompt's owner. */
export function probeOutcome(frame: string, canDiscloseHooks = true) {
  const { responder, show, refusals, writes } = probeResponder(canDiscloseHooks);
  const outcomes = show(frame);
  const owner = responder.humanOwnedPrompt;
  responder.dispose();
  return { outcomes, writes, refusals, owner };
}

/** Left to a human: nothing is written, and the refusal is reported once, with `reason`. */
export const refusedOutcome = (
  reason: ProbeTrustRefusal,
  owner: TrustPromptIdFor<"claude"> = "workspace_trust",
) => ({
  outcomes: [],
  writes: [],
  refusals: [reason],
  owner,
});
