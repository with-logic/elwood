/**
 * Claude 2.1.310's bypass-permissions acceptance dialog (C-CLAUDE-21), as the real CLI
 * renders it in a config dir where it was never accepted
 * (`tests/fixtures/claude-2.1.310/bypass-permissions-*.txt`, see the README). 2.1.310 adds a
 * sandbox sentence and the security-guide link to the 2.1.268 copy, and opens with the
 * cursor on `No, exit`. Under autotrust the dialog is recognized at either width, and
 * without its optional sentences, and answered with its affirmative: the attempt settles
 * `answered` only once the bypass-mode composer replaces it.
 */

import { expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const frame = (cols: number) => capturedFrame(`claude-2.1.310/bypass-permissions-${cols}`);

/** The 200-column capture with only the dialog's required sentence (C-CLAUDE-21). */
const requiredOnly = frame(200)
  .split("\n")
  .filter((line) => !/This mode should only|By proceeding|https:\/\//.test(line))
  .join("\n");

// A 2.1.310 session running in bypass mode: the composer the accepted dialog gives way to.
const running = readNativeInputFrame(
  new URL("../fixtures/claude-2.1.310/mode-footers/plain-bypass-permissions.json", import.meta.url),
).text;

const dialogs = [
  ["2.1.310's dialog at 100 columns", frame(100)],
  ["2.1.310's dialog at 200 columns", frame(200)],
  ["the dialog with only its required sentence", requiredOnly],
] as const;

for (const [name, dialog] of dialogs) {
  test(`C-CLAUDE-21 answers ${name} with Yes, I accept`, async () => {
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
        if (input.endsWith("\r")) rendered = running;
      },
      () => rendered,
    );
    expect(result).toMatchObject({
      kind: "attempted",
      automation: { prompt: "bypass_permissions", input: "home+down+enter" },
    });
    if (result?.kind !== "attempted") throw new Error("expected an answered prompt");
    await expect(result.settled).resolves.toBe("answered");
    expect(writes).toEqual(["\u001b[H\u001b[B", "\u001b[H\u001b[B\r"]);
  });
}
