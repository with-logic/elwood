/**
 * Recognition-focused coverage for the allowlisted trust-prompt automation:
 * partial renders, option-only spoofing, and blank-line layouts. The policy is
 * "never block — say yes to any RECOGNIZED allowlisted prompt", so the only
 * guard exercised here is recognition (allowlisted id + non-option HEADER
 * wording); there is deliberately NO region isolation or destructive-rider
 * refusal. Covers PRD §5.1 (C-CLAUDE-14, C-CODEX-15).
 */

import { describe, expect, test } from "vitest";
import { TrustPromptResponder } from "../../src/core/trust-responder.ts";

describe("trust-prompt automation security", () => {
  test("C-CLAUDE-14 a partial frame with a NON-affirmative option can still answer later", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Frame 1: header + a non-affirmative option ("No, cancel") only — the real
    // "Yes" hasn't rendered. It surfaces option_pending ONCE but must NOT settle.
    expect(
      responder.handle("Do you trust this folder?\n1. No, cancel", (input) => {
        writes.push(input);
      }),
    ).toEqual({ kind: "option_pending", prompt: "workspace_trust" });
    // Same partial frame again: reported once, so no second pending signal.
    expect(
      responder.handle("Do you trust this folder?\n1. No, cancel", (input) => {
        writes.push(input);
      }),
    ).toBeUndefined();
    // Frame 2: the affirmative finally rendered — the prompt is answered, not wedged.
    expect(
      responder.handle("Do you trust this folder?\n1. Yes, proceed\n2. No, cancel", (input) => {
        writes.push(input);
      }),
    ).toMatchObject({ kind: "answered", automation: { prompt: "workspace_trust", input: "1" } });
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
    expect(
      responder.handle(frame, (input) => {
        writes.push(input);
      }),
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-14 a WRAPPED option continuation cannot spoof a trust header", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A hostile dialog whose numbered option WRAPS onto a second physical row
    // carrying an allowlisted trust header phrase. That continuation row does not
    // itself start with "N.", but it is part of the option region (after the
    // first option), so header recognition must NOT see it. Otherwise the
    // responder would recognize `workspace_trust` and auto-confirm an unrelated,
    // possibly destructive, first option.
    const frame =
      "Delete all stored credentials?\n1. Yes, wipe everything and also\n   Do you trust this folder?\n2. No, cancel";
    expect(
      responder.handle(frame, (input) => {
        writes.push(input);
      }),
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-14 the ONLY guard is allowlisted + non-option-header recognition", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // Policy: never leave the agent waiting — a RECOGNIZED trust prompt is answered
    // from its affirmative, whatever the option text. The single remaining guard is
    // recognition itself: an off-allowlist dialog, and a trust phrase appearing
    // ONLY in an option label, are NOT recognized and never answered.
    expect(
      responder.handle("Enable telemetry?\n1. Yes", (input) => {
        writes.push(input);
      }),
    ).toBeUndefined(); // off-allowlist: not answered
    expect(
      responder.handle("Migration\n1. Yes, trust this plugin now", (input) => {
        writes.push(input);
      }),
    ).toBeUndefined(); // trust phrase only in the option: not recognized, not answered
    // But a genuinely recognized plugin-trust HEADER is answered from its option.
    expect(
      responder.handle("Do you trust the plugin?\n1. Yes, trust it\n2. No", (input) => {
        writes.push(input);
      }),
    ).toMatchObject({ kind: "answered", automation: { prompt: "plugin_trust", input: "1" } });
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CLAUDE-14 a recognized trust dialog is answered even across a blank line", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A single trust dialog whose header and options are separated by a blank +
    // descriptive line — the real rendered shape. Elwood recognizes the header and
    // answers the affirmative so the agent never waits on the trust gate. There is
    // NO region isolation by design (say-yes-to-anything policy): recognition is
    // the only guard, and the responder answers the first affirmative option in
    // the frame. A stacked second dialog is not defended against here — that is an
    // accepted consequence of the policy (see VALIDATION-DECISIONS.md), not a
    // guarantee this test makes.
    const frame =
      "Do you trust this folder?\n\nReview the files first.\n1. Yes, proceed\n2. No, exit";
    expect(
      responder.handle(frame, (input) => {
        writes.push(input);
      }),
    ).toMatchObject({
      kind: "answered",
      automation: { prompt: "workspace_trust", input: "1" },
    });
    expect(writes).toEqual(["1\r"]);
  });
});
