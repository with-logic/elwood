/**
 * Cursor-layout parsing and navigation coverage for Claude trust prompts.
 * Implements PRD §5.1 (C-CLAUDE-10, C-CLAUDE-14, C-E2E-09).
 */

import { describe, expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import {
  optionInput,
  optionKeystrokes,
  selectableOptions,
} from "../../src/core/terminal-options.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { claudeComposer, claudeTrust } from "../fixtures/trust-composer.ts";

describe("cursor-style trust prompts", () => {
  test("C-CLAUDE-10 keeps the real Claude 2.1.206 numbered layout working", async () => {
    const frame = [
      "Quick safety check: Is this a project you created or one you",
      "trust? (Like your own code, a well-known open source project). If not,",
      "take a moment to review what's in this folder first.",
      "Claude Code'll be able to read, edit, and execute files here.",
      "Security guide",
      "❯ 1. Yes, I trust this folder",
      "  2. No, exit",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const writes: string[] = [];
    const result = new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
      frame,
      (input) => {
        writes.push(input);
      },
    );
    expect(result).toMatchObject({
      kind: "attempted",
      automation: { prompt: "workspace_trust", input: "1" },
    });
    if (result?.kind === "attempted") await result.settled;
    expect(writes).toEqual(["1\r"]);
    expect(optionKeystrokes(selectableOptions(frame)[0]!)).toEqual(["1\r"]);
  });

  test("C-CLAUDE-14 derives selected, upward, and multi-step affirmative input", () => {
    for (const [frame, input, keys] of [
      ["Do you trust this folder?\n❯ Yes, I trust this folder\n  No", "enter", ["\r"]],
      [
        "Do you trust this folder?\n  Yes, I trust this folder\n❯ No",
        "up+enter",
        ["\u001b[A", "\r"],
      ],
      [
        "New MCP server found in this project\n  Use this MCP server\n  Use all future servers\n❯ No",
        "up+up+enter",
        ["\u001b[A", "\u001b[A", "\r"],
      ],
    ] as const) {
      const option = selectableOptions(frame).find((candidate) =>
        /yes|use this/i.test(candidate.label),
      );
      expect(option).toBeDefined();
      if (option === undefined) continue;
      expect(optionInput(option)).toBe(input);
      expect(optionKeystrokes(option)).toEqual(keys);
    }
  });

  test("C-CLAUDE-10 answers the real Claude 2.1.252 cursor-style frame", async () => {
    const frame = [
      "Accessing workspace:",
      "",
      " /Users/steve",
      "",
      "Quick safety check: Is this a project you created or one you",
      "trust? (Like your own code, a well-known open source project, or work from your team). If not,",
      "take a moment to review what's in this folder first.",
      "",
      "Claude Code'll be able to read, edit, and execute files here.",
      "",
      "Security guide",
      "",
      "❯ No, exit",
      "  Yes, I trust this folder",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const writes: string[] = [];
    let rendered = frame;
    const result = new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
      frame,
      (input) => {
        writes.push(input);
        rendered =
          input === "\u001b[B"
            ? frame.replace("❯ No, exit\n  Yes", "  No, exit\n❯ Yes")
            : claudeComposer;
      },
      () => rendered,
    );
    expect(result).toMatchObject({
      kind: "attempted",
      automation: { prompt: "workspace_trust", input: "down+enter" },
    });
    if (result?.kind === "attempted") await result.settled;
    expect(writes).toEqual(["\u001b[B", "\r"]);
  });

  test("C-CLAUDE-14 navigates upward before confirming", async () => {
    const frame = `${claudeTrust}\n  Yes, I trust this folder\n❯ No`;
    const writes: string[] = [];
    let rendered = frame;
    const result = new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
      frame,
      (input) => {
        writes.push(input);
        rendered =
          input === "\u001b[A"
            ? `${claudeTrust}\n❯ Yes, I trust this folder\n  No`
            : claudeComposer;
      },
      () => rendered,
    );
    if (result?.kind === "attempted") await result.settled;
    expect(writes).toEqual(["\u001b[A", "\r"]);
  });
});
