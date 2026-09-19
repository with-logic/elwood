/**
 * Claude's one-time bypass-permissions acceptance dialog as an allowlisted trust
 * prompt: header-anchored recognition, numbered and cursor affirmative selection,
 * footer/option-only non-matches, and the autotrust-off blocking classification.
 * Wording is the claude 2.1.268 binary's (`docs/cli-behavior.md`). Covers C-CLAUDE-21.
 */

import { describe, expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { blockingTrustSpecs } from "../../src/core/trust/prompts.ts";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";

const header = [
  " WARNING: Claude Code running in Bypass Permissions mode",
  "",
  " In Bypass Permissions mode, Claude Code will not ask for your approval before running",
  " potentially dangerous commands.",
  "",
  " By proceeding, you accept all responsibility for actions taken while running in Bypass",
  " Permissions mode.",
  "",
];

const numberedDialog = [
  ...header,
  " ❯ 1. No, exit",
  "   2. Yes, I accept",
  "",
  " Enter to confirm",
].join("\n");

const cursorDialog = [...header, " ❯ No, exit", "   Yes, I accept", "", " Enter to confirm"].join(
  "\n",
);

// The persistent footer of a session already running in bypass mode (real 2.1.268 frame).
const runningFooter =
  "❯ \n  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";

describe("bypass-permissions acceptance dialog", () => {
  test("C-CLAUDE-21 answers the numbered layout with its own affirmative, never the decline", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder<"claude">("claude", claudeTrustClearance, true);
    expect(
      responder.handle(numberedDialog, (input) => {
        writes.push(input);
      }),
    ).toMatchObject({
      kind: "attempted",
      automation: { prompt: "bypass_permissions", input: "2" },
    });
    expect(writes).toEqual(["2\r"]);
    // Answered once: the same frame again is not re-answered.
    expect(responder.handle(numberedDialog, () => undefined)).toBeUndefined();
  });

  test("C-CLAUDE-21 navigates the cursor layout down to the affirmative and confirms", async () => {
    const writes: string[] = [];
    let rendered = cursorDialog;
    const responder = new TrustPromptResponder<"claude">("claude", claudeTrustClearance, true);
    const result = responder.handle(
      cursorDialog,
      (input) => {
        writes.push(input);
        if (input === "\u001b[B")
          rendered = [...header, "   No, exit", " ❯ Yes, I accept", "", " Enter to confirm"].join(
            "\n",
          );
        if (input === "\r") rendered = runningFooter;
      },
      () => rendered,
    );
    expect(result).toMatchObject({
      kind: "attempted",
      automation: { prompt: "bypass_permissions", input: "down+enter" },
    });
    if (result?.kind !== "attempted") throw new Error("expected an answered prompt");
    await result.settled;
    expect(writes).toEqual(["\u001b[B", "\r"]);
  });

  test("C-CLAUDE-21 a decline-only partial frame is pending, not answered", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder<"claude">("claude", claudeTrustClearance, true);
    expect(
      responder.handle([...header, " ❯ 1. No, exit"].join("\n"), (input) => {
        writes.push(input);
      }),
    ).toEqual({ kind: "option_pending", prompt: "bypass_permissions" });
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-21 the running-session footer and an option-only phrase never match", () => {
    expect(trustPromptVisible(runningFooter, "claude")).toBe(false);
    const spoof = "Unrelated confirmation\n1. Yes, I accept running in Bypass Permissions mode";
    expect(trustPromptVisible(spoof, "claude")).toBe(false);
    const responder = new TrustPromptResponder<"claude">("claude", claudeTrustClearance, true);
    expect(responder.handle(runningFooter, () => undefined)).toBeUndefined();
    expect(responder.handle(spoof, () => undefined)).toBeUndefined();
  });

  test("C-CLAUDE-21 without autotrust the dialog is left to the human and blocks", () => {
    const responder = new TrustPromptResponder<"claude">("claude", claudeTrustClearance, false);
    expect(responder.handle(numberedDialog, () => undefined)).toBeUndefined();
    expect(trustPromptVisible(numberedDialog, "claude")).toBe(true);
    const blocking = blockingTrustSpecs("claude", false).map((spec) => spec.id);
    expect(blocking).toContain("bypass_permissions");
    expect(blockingTrustSpecs("claude", true)).toEqual([]);
  });
});
