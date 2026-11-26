/**
 * Claude's prompt for one new project MCP server (PRD §5.4, C-CLAUDE-28): autotrust verifies it
 * only with its native body and `Esc to reject` footer, wrapped at either width, and answers it
 * with "Use this MCP server"; a missing or changed body, or another footer, fails closed.
 */
import { expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { autotrustAnswer, autotrustView, failedClosed } from "../helpers/claude-autotrust.ts";
import {
  claudeMcpServerPrompt,
  claudeMcpServerPromptNarrow,
} from "../helpers/claude-workspace-trust-screen.ts";

const body =
  "MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP\n  documentation.";

/** Moves the MCP server prompt's caret to "Use this MCP server". */
function selectUseThisServer(screen: string): string {
  return screen
    .replace("    Use this MCP server\n", "  ❯ Use this MCP server\n")
    .replace("  ❯ Continue without", "    Continue without");
}

test.each([
  ["120", claudeMcpServerPrompt],
  ["100", claudeMcpServerPromptNarrow],
])("C-CLAUDE-28 autotrust uses the server Claude's MCP server prompt offers, at %s columns", async (_, frame) => {
  expect(trustView(frame, "claude", claudeTrustClearance)).toMatchObject({
    kind: "candidate",
    valid: true,
    spec: { id: "mcp_trust" },
  });
  expect(await autotrustAnswer(frame, selectUseThisServer)).toMatchObject({
    result: { automation: { prompt: "mcp_trust", input: "home+enter" } },
    completion: "answered",
    writes: ["\u001b[H", "\u001b[H\r"],
  });
});

test.each([
  ["without its body", [`\n  ${body}\n`, ""]],
  ["with a changed body", ["All tool calls require approval.", "Tool calls run unattended."]],
  ["with another footer", ["Esc to reject", "Esc to dismiss"]],
] as const)("C-CLAUDE-28 the MCP server prompt %s fails closed", (_, [from, to]) => {
  const frame = claudeMcpServerPrompt.replace(from, to);
  expect(frame).not.toBe(claudeMcpServerPrompt);
  expect(autotrustView(frame)).toEqual(failedClosed);
});
