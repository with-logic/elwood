/**
 * Trust recognition preserves wrapped/descriptive layouts while isolating the
 * active dialog. Covers PRD §5.4, C-TRUST-01, C-CLAUDE-14, and C-CODEX-15.
 */

import { describe, expect, test, vi } from "vitest";
import type { StartupWriteCompletion } from "../../src/core/startup/write.ts";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

/** Await an attempted prompt’s completion; a missing attempt fails the test (never vacuous). */
function settlementOf(result: TrustPromptResult<"claude">): Promise<StartupWriteCompletion> {
  if (result?.kind !== "attempted") throw new Error(`not attempted: ${result?.kind}`);
  return result.settled;
}

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
    ).toMatchObject({ kind: "attempted", automation: { prompt: "workspace_trust", input: "1" } });
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

  test("C-CLAUDE-14 an unnumbered option above the cursor cannot spoof a trust header", () => {
    const writes: string[] = [];
    const frame = "Unrecognized migration\n  Do you trust this folder?\n❯ No, cancel";
    expect(
      new TrustPromptResponder("claude", true).handle(frame, (input) => {
        writes.push(input);
      }),
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-14 cursor navigation fails closed without live screen reads", async () => {
    const frame = "Do you trust this folder?\n❯ No\n  Yes, I trust this folder";
    const result = new TrustPromptResponder("claude", true).handle(frame, () => undefined);
    await expect(settlementOf(result)).resolves.toBe("cancelled");
  });

  test("C-CLAUDE-14 cursor navigation never continues into a replacement screen", async () => {
    const initial = "Do you trust this folder?\n❯ No\n  Yes, I trust this folder";
    let frame = initial;
    const result = new TrustPromptResponder("claude", true).handle(
      initial,
      () => {
        frame = "Different prompt\n❯ Yes, proceed";
      },
      () => frame,
    );
    await expect(settlementOf(result)).resolves.toBe("cancelled");

    const replaced = new TrustPromptResponder("claude", true).handle(
      initial,
      () => undefined,
      () => "Different prompt\n❯ Yes, proceed",
    );
    await expect(settlementOf(replaced)).resolves.toBe("cancelled");
  });

  test("C-CLAUDE-14 unchanged or partial cursor frames time out and stay retryable", async () => {
    vi.useFakeTimers();
    try {
      const initial = "Do you trust this folder?\n❯ No\n  Yes, I trust this folder";
      const started = Date.now();
      const responder = new TrustPromptResponder("claude", true);
      const result = responder.handle(
        initial,
        () => undefined,
        () => (Date.now() - started < 300 ? initial : "Do you trust this folder?"),
      );
      const cancelled = expect(settlementOf(result)).resolves.toBe("cancelled");
      await vi.runAllTimersAsync();
      await cancelled;
      let retryFrame = initial;
      const retry = responder.handle(
        initial,
        (input) => {
          retryFrame =
            input === "\u001b[B"
              ? "Do you trust this folder?\n  No\n❯ Yes, I trust this folder"
              : claudeComposer;
        },
        () => retryFrame,
      );
      const retried = settlementOf(retry);
      await vi.runAllTimersAsync();
      await retried;
    } finally {
      vi.useRealTimers();
    }
  });

  test("C-CLAUDE-14 only an allowlisted non-option header identifies a trust prompt", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A native active dialog is answered from its own affirmative. Off-allowlist
    // dialogs and trust phrases appearing only inside options do not identify it.
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
    ).toMatchObject({ kind: "attempted", automation: { prompt: "plugin_trust", input: "1" } });
    expect(writes).toEqual(["1\r"]);
  });

  test("C-CLAUDE-14 a recognized trust dialog is answered even across a blank line", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    // A single trust dialog whose header and options are separated by a blank +
    // descriptive line — the real rendered shape. Elwood recognizes the header and
    // answers the affirmative so the agent never waits on the trust gate. There is
    // no second dialog here: blank/descriptive rows remain part of this one.
    const frame =
      "Do you trust this folder?\n\nClaude Code'll be able to read, edit, and execute files here.\n1. Yes, proceed\n2. No, exit";
    expect(
      responder.handle(frame, (input) => {
        writes.push(input);
      }),
    ).toMatchObject({
      kind: "attempted",
      automation: { prompt: "workspace_trust", input: "1" },
    });
    expect(writes).toEqual(["1\r"]);
  });
});
