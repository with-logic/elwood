/**
 * Claude 2.1.310's bypass-permissions acceptance dialog (C-CLAUDE-21), as the real CLI
 * renders it in a config dir where it was never accepted
 * (`tests/fixtures/claude-2.1.310/bypass-permissions-*.txt`, see the README). 2.1.310 adds a
 * sandbox sentence and the security-guide link to the 2.1.268 copy, and opens with the
 * cursor on `No, exit`. Under autotrust the dialog is recognized at either width and
 * answered with its affirmative.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";

const frame = (cols: number) =>
  readFileSync(
    new URL(`../fixtures/claude-2.1.310/bypass-permissions-${cols}.txt`, import.meta.url),
    "utf8",
  );

// The same session once the dialog is accepted: its bypass-mode footer.
const runningFooter = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";

for (const cols of [100, 200]) {
  test(`C-CLAUDE-21 answers 2.1.310's dialog at ${cols} columns with Yes, I accept`, async () => {
    const dialog = frame(cols);
    expect(trustPromptVisible(dialog, "claude")).toBe(true);
    const writes: string[] = [];
    let rendered = dialog;
    const responder = new TrustPromptResponder<"claude">("claude", claudeTrustClearance, true);
    const result = responder.handle(
      dialog,
      (input) => {
        writes.push(input);
        if (input === "\u001b[H\u001b[B")
          rendered = dialog
            .replace("  ❯ No, exit", "    No, exit")
            .replace("    Yes, I accept", "  ❯ Yes, I accept");
        if (input.endsWith("\r")) rendered = runningFooter;
      },
      () => rendered,
    );
    expect(result).toMatchObject({
      kind: "attempted",
      automation: { prompt: "bypass_permissions", input: "home+down+enter" },
    });
    if (result?.kind !== "attempted") throw new Error("expected an answered prompt");
    await result.settled;
    expect(writes).toEqual(["\u001b[H\u001b[B", "\u001b[H\u001b[B\r"]);
  });
}
