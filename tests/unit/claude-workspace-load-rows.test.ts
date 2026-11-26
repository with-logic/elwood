/**
 * Claude's workspace load row (PRD §5.4, C-CLAUDE-27): every captured load row verifies and
 * says what trusting the folder loads, autotrust answers it, and a changed row or annotation
 * fails closed, as does Claude's MCP server prompt with its native body.
 */
import { expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import {
  claudeWorkspaceDisclosesHooks,
  claudeWorkspaceStrongestDisclosure,
} from "../../src/core/trust/copy.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import {
  claudeLoadRowCaptures,
  claudeMcpServerPrompt,
  claudeSettingsEnvPrompt,
  selectClaudeHooksYes,
} from "../helpers/claude-workspace-trust-screen.ts";

const mcpOnly = capturedFrame("claude-2.1.332/trust/workspace-mcp-120");
const mcpRow = "Trusting this folder loads .mcp.json here or above (MCP servers).";

/** Autotrust's answer to `frame`, re-rendered by `select` after its selection and cleared after Enter. */
async function autotrustAnswer(frame: string, select: (screen: string) => string) {
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
function autotrustView(frame: string) {
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
const failedClosed = { kind: "candidate", valid: false, outcome: undefined, writes: [] };

test.each(
  claudeLoadRowCaptures,
)("C-CLAUDE-27 the captured load row %s verifies and discloses what trusting loads", async (_, frame, disclosure) => {
  const view = trustView(frame, "claude", claudeTrustClearance);
  expect(view).toMatchObject({ kind: "candidate", valid: true, spec: { id: "workspace_trust" } });
  const header = view.kind === "candidate" ? view.dialog.header : "";
  expect(claudeWorkspaceStrongestDisclosure(header)).toBe(disclosure);
  expect(claudeWorkspaceDisclosesHooks(header)).toBe(disclosure === "hooks");
  expect(await autotrustAnswer(frame, selectClaudeHooksYes)).toMatchObject({
    result: { automation: { prompt: "workspace_trust", input: "home+down+enter" } },
    completion: "answered",
  });
});

test("C-CLAUDE-27 the plain prompt discloses nothing", () => {
  const plain = mcpOnly.replace(`\n ${mcpRow}`, "");
  const view = trustView(plain, "claude", claudeTrustClearance);
  expect(view).toMatchObject({ kind: "candidate", valid: true });
  expect(view.kind === "candidate" && claudeWorkspaceStrongestDisclosure(view.dialog.header)).toBe(
    undefined,
  );
});

test.each([
  ["the local settings file alone", ".claude/settings.local.json.", "settings"],
  [
    "the local settings file and MCP servers",
    ".claude/settings.local.json and .mcp.json here or above (MCP servers).",
    "mcp_servers",
  ],
] as const)("C-CLAUDE-27 a load row naming %s verifies", (_, items, disclosure) => {
  const frame = mcpOnly.replace(mcpRow, `Trusting this folder loads ${items}`);
  const view = trustView(frame, "claude", claudeTrustClearance);
  expect(view).toMatchObject({ kind: "candidate", valid: true });
  expect(view.kind === "candidate" && claudeWorkspaceStrongestDisclosure(view.dialog.header)).toBe(
    disclosure,
  );
});

test("C-CLAUDE-27 a settings file that sets environment variables fails closed", () => {
  expect(claudeSettingsEnvPrompt).toContain(
    "loads .claude/settings.json (sets environment variables).",
  );
  expect(autotrustView(claudeSettingsEnvPrompt)).toEqual(failedClosed);
});

test.each([
  [
    "MCP servers before a settings file",
    ".mcp.json here or above (MCP servers) and .claude/settings.json.",
  ],
  ["the settings files out of order", ".claude/settings.local.json and .claude/settings.json."],
  [
    "three items without the serial comma",
    ".claude/settings.json, .claude/settings.local.json and .mcp.json here or above (MCP servers).",
  ],
  ["two items joined by a comma", ".claude/settings.json, .mcp.json here or above (MCP servers)."],
  ["commands without the hooks warning", ".claude/settings.json (runs commands)."],
  ["an unknown item", ".claude/agents."],
] as const)("C-CLAUDE-27 a load row with %s fails closed", (_, items) => {
  const frame = mcpOnly.replace(mcpRow, `Trusting this folder loads ${items}`);
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test("C-CLAUDE-27 another warning before the load row fails closed", () => {
  const frame = mcpOnly.replace(
    mcpRow,
    `⚠ This folder pre-approves 3 tool permissions\n\n ${mcpRow}`,
  );
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test("C-CLAUDE-27 Claude's MCP server prompt with its native body fails closed", () => {
  expect(autotrustView(claudeMcpServerPrompt)).toEqual(failedClosed);
});
