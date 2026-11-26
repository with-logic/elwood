/**
 * Claude's prompt for one new project MCP server (PRD §5.4, C-CLAUDE-28): autotrust verifies it
 * only with its native body, wrapped at either width, and answers it with "Use this MCP server",
 * even before its footer paints, never with the all-future option; a missing or changed body, or
 * an unknown footer row, fails closed. Its `Esc to reject` footer ends no other dialog.
 */
import { describe, expect, test } from "vitest";
import {
  claudeScreenFactTableForTrustPolicy,
  claudeTrustClearance,
} from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { trustGateVisible } from "../../src/core/trust/blocking.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { autotrustAnswer, autotrustView, failedClosed } from "../helpers/claude-autotrust.ts";
import {
  claudeMcpServerPrompt,
  claudeMcpServerPromptNarrow,
} from "../helpers/claude-workspace-trust-screen.ts";

const body =
  "MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP\n  documentation.";
const footer = "Enter to confirm · Esc to reject";

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
  ["with an unknown footer row", ["Esc to reject", "Esc to dismiss"]],
] as const)("C-CLAUDE-28 the MCP server prompt %s fails closed", (_, [from, to]) => {
  const frame = claudeMcpServerPrompt.replace(from, to);
  expect(frame).not.toBe(claudeMcpServerPrompt);
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test("C-CLAUDE-28 autotrust answers the MCP server prompt before its footer paints", async () => {
  const frame = claudeMcpServerPrompt.replace(footer, "");
  expect(frame).not.toBe(claudeMcpServerPrompt);
  expect(await autotrustAnswer(frame, selectUseThisServer)).toMatchObject({
    result: { automation: { prompt: "mcp_trust", input: "home+enter" } },
    completion: "answered",
  });
});

test("C-CLAUDE-28 autotrust never picks the MCP server prompt's all-future option", () => {
  const one = "    Use this MCP server\n";
  const all = "    Use this and all future MCP servers in this project\n";
  const frame = claudeMcpServerPrompt.replace(`${one}${all}`, `${all}${one}`);
  expect(frame).not.toBe(claudeMcpServerPrompt);
  expect(trustView(frame, "claude", claudeTrustClearance)).toMatchObject({
    kind: "candidate",
    valid: true,
    option: { label: "Use this MCP server" },
  });
});

test("C-CLAUDE-28 the MCP server prompt's footer ends no other gate's dialog", () => {
  const workspace = capturedFrame("claude-2.1.332/trust/workspace-mcp-120");
  expect(autotrustView(workspace).valid).toBe(true);
  const frame = workspace.replace("Enter to confirm · Esc to cancel", footer);
  expect(frame).not.toBe(workspace);
  expect(autotrustView(frame)).toEqual(failedClosed);
});

// An agent reply whose conversation row has scrolled off the viewport: only the footer's
// binding to its own gate keeps these rows from reading as an unrecognized trust gate.
const reply = `  Do you want me to keep going?\n  1. Keep going\n  2. Stop here\n\n  ${footer}`;

describe.each([true, false])("autotrust %s", (autotrust) => {
  test("C-CLAUDE-28 the MCP server prompt's footer in conversation text is no trust gate", () => {
    expect(trustView(reply, "claude", claudeTrustClearance)).toEqual({ kind: "unknown" });
    expect(trustGateVisible(reply, "claude")).toBe(false);
    const facts = readScreenFacts(claudeScreenFactTableForTrustPolicy(autotrust), {
      text: reply,
      title: "",
    });
    expect(facts.matched.filter((rule) => rule.fact === "blocking_prompt_visible")).toEqual([]);
  });
});

// Synthetic, from the 2.1.332 binary's strings (not captured): its checklist for several servers.
const checklist = [
  "  3 new MCP servers found in this project",
  "  Select any you wish to enable.",
  "",
  "  ❯ [✔] alpha",
  "    [✔] beta",
  "    [✔] gamma",
  "    Enable selected",
].join("\n");

test("C-CLAUDE-28 Claude's checklist for several new MCP servers is never answered", () => {
  expect(trustView(checklist, "claude", claudeTrustClearance)).toEqual({ kind: "unknown" });
  expect(autotrustView(checklist).writes).toEqual([]);
});
