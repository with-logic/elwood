/**
 * What Claude's autotrust does with a captured trust prompt: whether it verifies, what it
 * writes, and how its answer settles, for the workspace and MCP server prompt tests (PRD §5.4,
 * C-CLAUDE-29, C-CLAUDE-28).
 */
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

/** Autotrust's answer to `frame`, re-rendered by `select` after its selection and cleared after Enter. */
export async function autotrustAnswer(frame: string, select: (screen: string) => string) {
  const writes: string[] = [];
  let rendered = frame;
  const result = new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
    frame,
    (input) => {
      writes.push(input);
      rendered = input.endsWith("\r") ? claudeComposer : select(frame);
    },
    () => rendered,
  );
  const completion = result?.kind === "attempted" ? await result.settled : undefined;
  return { result, completion, writes };
}

/** How autotrust treats `frame`: its view's kind and validity, its outcome, and its writes. */
export function autotrustView(frame: string) {
  const view = trustView(frame, "claude", claudeTrustClearance);
  const writes: string[] = [];
  const outcome = new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
    frame,
    (input) => {
      writes.push(input);
    },
  );
  return { kind: view.kind, valid: view.kind === "candidate" && view.valid, outcome, writes };
}

/** A recognized prompt that is held, never verified, and never written to. */
export const failedClosed = { kind: "candidate", valid: false, outcome: undefined, writes: [] };
