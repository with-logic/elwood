/**
 * Security-focused coverage for the allowlisted trust-prompt automation: partial
 * renders, option-only spoofing, destructive riders, and blank-line layouts.
 * Covers PRD §5.1 (C-CLAUDE-14, C-CODEX-15).
 */

import { describe, expect, test } from "vitest";
import { TrustPromptResponder } from "../../src/core/trust-responder.ts";

describe("trust-prompt automation security", () => {
  test("C-CLAUDE-14 a partial frame with a NON-affirmative option can still answer later", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Frame 1: header + a non-affirmative option ("No, cancel") only — the real
    // "Yes" hasn't rendered. It surfaces unanswerable ONCE but must NOT settle.
    expect(
      responder.handle("Do you trust this folder?\n1. No, cancel", (input) => writes.push(input)),
    ).toEqual({ kind: "unanswerable", prompt: "workspace_trust" });
    // Same partial frame again: reported once, so no second wedge signal.
    expect(
      responder.handle("Do you trust this folder?\n1. No, cancel", (input) => writes.push(input)),
    ).toBeUndefined();
    // Frame 2: the affirmative finally rendered — the prompt is answered, not wedged.
    expect(
      responder.handle("Do you trust this folder?\n1. Yes, proceed\n2. No, cancel", (input) =>
        writes.push(input),
      ),
    ).toEqual({ kind: "answered", automation: { prompt: "workspace_trust", input: "1" } });
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CLAUDE-14 an OPTION-ONLY trust phrase never identifies a prompt", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A hostile dialog whose HEADER is unrelated but whose OPTION embeds a trust
    // phrase plus a destructive rider. Recognition anchors on a HEADER line, so
    // the phrase in an option can never identify the prompt: nothing is written
    // and no automation fires (the destructive action is never auto-confirmed).
    const frame =
      "Unrecognized security migration\n1. Yes, trust this plugin and grant administrator access";
    expect(responder.handle(frame, (input) => writes.push(input))).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-14 a recognized prompt with a destructive-rider affirmative is not confirmed", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Even with a genuine plugin-trust HEADER, an affirmative option that riders a
    // destructive action is rejected as unclean: unanswerable, never selected.
    const frame = "Do you trust the plugin?\n1. Yes, trust it and delete stored credentials\n2. No";
    expect(responder.handle(frame, (input) => writes.push(input))).toEqual({
      kind: "unanswerable",
      prompt: "plugin_trust",
    });
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-14 a recognized trust dialog is answered even across a blank line", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A single trust dialog whose header and options are separated by a blank +
    // descriptive line — the real rendered shape. Elwood recognizes the header and
    // answers the affirmative so the agent never waits on the trust gate. (Region
    // isolation from a SECOND trust dialog is still enforced — see the two-prompt
    // and option-only-spoof tests — but a plain blank does not stop the answer.)
    const frame =
      "Do you trust this folder?\n\nReview the files first.\n1. Yes, proceed\n2. No, exit";
    expect(responder.handle(frame, (input) => writes.push(input))).toEqual({
      kind: "answered",
      automation: { prompt: "workspace_trust", input: "1" },
    });
    expect(writes).toEqual(["1\r"]);
  });
});
