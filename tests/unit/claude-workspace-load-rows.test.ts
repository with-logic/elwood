/**
 * Claude's workspace load row (PRD §5.4, C-CLAUDE-29): every captured load row verifies and
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
)("C-CLAUDE-29 the captured load row %s verifies and discloses what trusting loads", async (_, frame, disclosure) => {
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

test("C-CLAUDE-29 the plain prompt discloses nothing", () => {
  const plain = mcpOnly.replace(`\n ${mcpRow}`, "");
  const view = trustView(plain, "claude", claudeTrustClearance);
  expect(view).toMatchObject({ kind: "candidate", valid: true });
  expect(view.kind === "candidate" && claudeWorkspaceStrongestDisclosure(view.dialog.header)).toBe(
    undefined,
  );
});

const S = ".claude/settings.json";
const L = ".claude/settings.local.json";
const M = ".mcp.json here or above (MCP servers)";
const runs = " (runs commands)";

/**
 * Every load row the grammar accepts, written out rather than generated: the files the hooks
 * warning names, if any, the row's items, and what the row discloses.
 */
const everyLoadRow = [
  [undefined, M, "mcp_servers"],
  [undefined, L, "settings"],
  [undefined, `${L} and ${M}`, "mcp_servers"],
  [L, `${L}${runs}`, "hooks"],
  [L, `${L}${runs} and ${M}`, "hooks"],
  [undefined, S, "settings"],
  [undefined, `${S} and ${M}`, "mcp_servers"],
  [undefined, `${S} and ${L}`, "settings"],
  [undefined, `${S}, ${L}, and ${M}`, "mcp_servers"],
  [L, `${S} and ${L}${runs}`, "hooks"],
  [L, `${S}, ${L}${runs}, and ${M}`, "hooks"],
  [S, `${S}${runs}`, "hooks"],
  [S, `${S}${runs} and ${M}`, "hooks"],
  [S, `${S}${runs} and ${L}`, "hooks"],
  [S, `${S}${runs}, ${L}, and ${M}`, "hooks"],
  [`${S} and ${L}`, `${S}${runs} and ${L}${runs}`, "hooks"],
  [`${S} and ${L}`, `${S}${runs}, ${L}${runs}, and ${M}`, "hooks"],
] as const;

test.each(
  everyLoadRow,
)("C-CLAUDE-29 a load row warning about %s and naming %s verifies", (warned, items, disclosure) => {
  const load = `Trusting this folder loads ${items}.`;
  const warning = `⚠ This folder configures hooks that can run commands without asking, declared in ${warned}`;
  const frame = mcpOnly.replace(mcpRow, warned === undefined ? load : `${warning}\n\n ${load}`);
  const view = trustView(frame, "claude", claudeTrustClearance);
  expect(view).toMatchObject({ kind: "candidate", valid: true });
  const header = view.kind === "candidate" ? view.dialog.header : "";
  expect(claudeWorkspaceStrongestDisclosure(header)).toBe(disclosure);
  expect(claudeWorkspaceDisclosesHooks(header)).toBe(disclosure === "hooks");
});

test("C-CLAUDE-29 a settings file that sets environment variables fails closed", () => {
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
] as const)("C-CLAUDE-29 a load row with %s fails closed", (_, items) => {
  const frame = mcpOnly.replace(mcpRow, `Trusting this folder loads ${items}`);
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test("C-CLAUDE-29 another warning before the load row fails closed", () => {
  const frame = mcpOnly.replace(
    mcpRow,
    `⚠ This folder pre-approves 3 tool permissions\n\n ${mcpRow}`,
  );
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test("C-CLAUDE-29 Claude's MCP server prompt with its native body fails closed", () => {
  expect(autotrustView(claudeMcpServerPrompt)).toEqual(failedClosed);
});
