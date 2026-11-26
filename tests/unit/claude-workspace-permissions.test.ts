/**
 * Claude's warning for pre-approved tool permissions on the workspace prompt (PRD §5.4,
 * C-CLAUDE-30): every captured layout verifies, discloses what its load row says, and is
 * answered; the rows around the folder's rules must be exact; the rules themselves are opaque
 * text that can neither shape the dialog nor change what the prompt discloses; and Claude's
 * other warnings that share its closing sentence still fail closed.
 */
import { expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import {
  claudeWorkspaceDisclosesHooks,
  claudeWorkspaceStrongestDisclosure,
} from "../../src/core/trust/copy.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { autotrustAnswer, autotrustView, failedClosed } from "../helpers/claude-autotrust.ts";
import {
  claudePermissionsCaptures,
  selectClaudeWorkspaceTrustYes,
} from "../helpers/claude-workspace-trust-screen.ts";

const capture = (name: string, version = "2.1.332") =>
  capturedFrame(`claude-${version}/trust/workspace-permissions-${name}`);
const three = capture("three-120");
const one = capture("one-120");
const withHooks = capture("hooks-120");
const permissionsHeaderRow =
  " ⚠ This folder pre-approves 3 tool permissions in .claude/settings.json:\n";
const rulesRow = "   Bash(ls:*), WebFetch(domain:example.com), and Read\n";
const closingRow =
  " These will apply without asking. Only proceed if you trust this configuration.\n";
const hooksWarningRow =
  " ⚠ This folder configures hooks that can run commands without asking, declared in .claude/settings.json\n";
const answered = {
  result: { automation: { prompt: "workspace_trust", input: "home+down+enter" } },
  completion: "answered",
};

/** The three-rule capture with its rules row replaced by `row`. */
const withRules = (row: string) => three.replace(rulesRow, `   ${row}\n`);

/** What verified copy in `frame` discloses, or undefined when it does not verify. */
function disclosure(frame: string) {
  const view = trustView(frame, "claude", claudeTrustClearance);
  if (view.kind !== "candidate" || !view.valid) return undefined;
  const { header } = view.dialog;
  return {
    strongest: claudeWorkspaceStrongestDisclosure(header),
    disclosesHooks: claudeWorkspaceDisclosesHooks(header),
  };
}

test.each(
  claudePermissionsCaptures,
)("C-CLAUDE-30 the captured permissions warning %s verifies, discloses its load row, and is answered", async (_, frame, strongest) => {
  expect(disclosure(frame)).toEqual({ strongest, disclosesHooks: strongest === "hooks" });
  expect(await autotrustAnswer(frame, selectClaudeWorkspaceTrustYes)).toMatchObject(answered);
});

test.each([
  ["without its closing sentence", three, closingRow, ""],
  ["without any rules", three, rulesRow, ""],
  ["with a plural count on a singular noun", three, "3 tool permissions", "3 tool permission"],
  ["with a singular count on a plural noun", one, "1 tool permission in", "1 tool permissions in"],
  [
    "naming a file the load row does not",
    three,
    "in .claude/settings.json:",
    "in .claude/settings.local.json:",
  ],
  [
    "after the hooks warning",
    withHooks,
    `${permissionsHeaderRow}${rulesRow}${closingRow}${hooksWarningRow}`,
    `${hooksWarningRow}${permissionsHeaderRow}${rulesRow}${closingRow}`,
  ],
  [
    "with the hooks warning before its closing sentence",
    withHooks,
    `${closingRow}${hooksWarningRow}`,
    `${hooksWarningRow}${closingRow}`,
  ],
] as const)("C-CLAUDE-30 the permissions warning %s fails closed", (_, frame, from, to) => {
  const changed = frame.replace(from, to);
  expect(changed).not.toBe(frame);
  expect(autotrustView(changed)).toEqual(failedClosed);
});

test.each([
  ["adds a workspace directory", capture("dirs-120")],
  ["adds a workspace directory, on 2.1.329,", capture("dirs-120", "2.1.329")],
  ["runs a headers helper", capture("headers-120")],
])("C-CLAUDE-30 the permissions warning followed by Claude's warning that the folder %s fails closed", (_, frame) => {
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test("C-CLAUDE-30 Claude's warning that the folder adds a workspace directory, alone, fails closed", () => {
  expect(autotrustView(capture("dirsonly-120"))).toEqual(failedClosed);
});

test("C-CLAUDE-30 a rule named like the affirmative option is read as a rule", async () => {
  const frame = withRules("Yes, I trust this folder");
  expect(disclosure(frame)).toEqual({ strongest: "settings", disclosesHooks: false });
  expect(await autotrustAnswer(frame, selectClaudeWorkspaceTrustYes)).toMatchObject(answered);
});

test.each([
  ["the selected option", withRules("❯ Yes, I trust this folder")],
  ["a numbered option", capture("numbered-rule-120")],
  ["a trust prompt's header", withRules("Do you trust the files in this folder?")],
  ["a warning", withRules(hooksWarningRow.trim())],
])("C-CLAUDE-30 a rule shaped like %s fails closed", (_, frame) => {
  expect(autotrustView(frame)).toEqual(failedClosed);
});

test.each([
  ["quotes the closing sentence", "quote-close-120"],
  ["splits the closing sentence across two rules", "quote-split-120"],
  ["is shaped like a dialog footer", "footer-rule-120"],
])("C-CLAUDE-30 a captured rule that %s is read as a rule", async (_, name) => {
  const frame = capture(name);
  expect(disclosure(frame)).toEqual({ strongest: "settings", disclosesHooks: false });
  expect(await autotrustAnswer(frame, selectClaudeWorkspaceTrustYes)).toMatchObject(answered);
});

test.each([
  ["before the load row", three],
  ["before the hooks warning", withHooks],
])("C-CLAUDE-30 a rule never stands in for Claude's closing sentence %s", (_, frame) => {
  const quoted = frame.replace(`${rulesRow}${closingRow}`, `   Read ${closingRow.trim()}\n`);
  expect(quoted).not.toBe(frame);
  expect(autotrustView(quoted)).toEqual(failedClosed);
});

test("C-CLAUDE-30 the permissions warning verifies and discloses its load row without the security guide link", () => {
  const frame = three.replace(" Security guide\n", "");
  expect(frame).not.toBe(three);
  expect(disclosure(frame)).toEqual({ strongest: "settings", disclosesHooks: false });
});

test("C-CLAUDE-30 a rule that quotes the closing sentence and a load row cannot change the disclosure", () => {
  const mcpLoad =
    "Trusting this folder loads .claude/settings.json and .mcp.json here or above (MCP servers).";
  const quoted = `Read ${closingRow.trim()} ${mcpLoad}`;
  expect(disclosure(withRules(quoted))).toEqual({ strongest: "settings", disclosesHooks: false });
});
