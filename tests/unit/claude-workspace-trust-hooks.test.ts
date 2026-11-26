/**
 * Claude's workspace prompt for a folder whose project settings have hooks: the hooks warning
 * before its load row, naming exactly the files the row marks ` (runs commands)`, is native
 * copy, anything else in its place fails closed, and the model probe's policy leaves it to a
 * human, as it does every workspace prompt from a Claude that cannot disclose hooks (PRD §5.3,
 * §5.4, C-CLAUDE-26, C-CLAUDE-29).
 */
import { expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { claudeWorkspaceDisclosesHooks } from "../../src/core/trust/copy/claude-workspace.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { autotrustAnswer } from "../helpers/claude-autotrust.ts";
import { probeOutcome, refusedOutcome } from "../helpers/claude-probe-responder.ts";
import {
  claudeHooksPrompt,
  claudeHooksPromptCaptures,
  claudeWorkspaceTrustScreen,
  claudeHooksSettingsLoad as load,
  selectClaudeWorkspaceTrustYes,
  claudeHooksWarning as warning,
} from "../helpers/claude-workspace-trust-screen.ts";

const { wide, wrapped } = claudeHooksPrompt;
const ableTo = "Claude Code'll be able to read, edit, and execute files here.";
const likeYourOwn =
  " (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what's in this folder first.";
const extra = "Hooks also run on every prompt.";
const local = ".claude/settings.local.json";
/** The load row Claude draws for hooks in `.claude/settings.local.json` alone. */
const localLoad = load.replace("settings.json", "settings.local.json");
const moveToYes = "\u001b[H\u001b[B";

const answered = {
  result: {
    kind: "attempted",
    automation: { prompt: "workspace_trust", input: "home+down+enter" },
  },
  completion: "answered",
  writes: [moveToYes, `${moveToYes}\r`],
};

test.each([
  ["unwrapped", wide],
  ["wrapped at 100 columns", wrapped],
])("C-CLAUDE-26 autotrust answers the hooks prompt (%s)", async (_, frame) => {
  expect(await autotrustAnswer(frame, selectClaudeWorkspaceTrustYes)).toMatchObject(answered);
});

test.each(
  claudeHooksPromptCaptures,
)("C-CLAUDE-26 autotrust answers the hooks prompt naming settings files (%s)", async (_, frame) => {
  const view = trustView(frame, "claude", claudeTrustClearance);
  expect(view).toMatchObject({ kind: "candidate", valid: true });
  expect(view.kind === "candidate" && claudeWorkspaceDisclosesHooks(view.dialog.header)).toBe(true);
  expect(await autotrustAnswer(frame, selectClaudeWorkspaceTrustYes)).toMatchObject(answered);
});

test("C-CLAUDE-26 autotrust answers the hooks prompt with only the closing explanation", async () => {
  const frame = wide.replace(likeYourOwn, "");
  expect(frame).not.toContain("Like your own code");
  expect(await autotrustAnswer(frame, selectClaudeWorkspaceTrustYes)).toMatchObject(answered);
});

test.each([
  ["the warning alone", [`\n\n ${load}`, ""]],
  ["the load row alone", [` ${warning}\n\n`, ""]],
  ["the rows reversed", [` ${warning}\n\n ${load}`, ` ${load}\n\n ${warning}`]],
  ["another settings file", [warning, warning.replace("settings.json", "settings.user.json")]],
  ["files that differ in the two rows", [load, localLoad]],
  ["a list without its conjunction", [warning, `${warning}, ${local}`]],
  ["prose between the rows", [` ${warning}\n`, ` ${warning}\n ${extra}\n`]],
  ["prose after the rows", [` ${load}`, ` ${load}\n ${extra}`]],
  ["the rows without the closing explanation", [` ${ableTo}\n\n`, ""]],
  [
    "the rows before the explanation",
    [` ${ableTo}\n\n ${warning}\n\n ${load}`, ` ${warning}\n\n ${load}\n\n ${ableTo}`],
  ],
] as const)("C-CLAUDE-26 %s fails closed", (_, [from, to]) => {
  const frame = wide.replace(from, to);
  expect(frame).not.toBe(wide);
  expect(trustView(frame, "claude", claudeTrustClearance)).toMatchObject({
    kind: "candidate",
    valid: false,
  });
  const write = vi.fn();
  expect(
    new TrustPromptResponder("claude", claudeTrustClearance, true).handle(frame, write),
  ).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

test("C-CLAUDE-26 only the pair of hooks rows declares hooks", () => {
  expect(claudeWorkspaceDisclosesHooks(`${ableTo} ${warning} ${load}`)).toBe(true);
  expect(claudeWorkspaceDisclosesHooks(`${ableTo} ${warning}`)).toBe(false);
  expect(claudeWorkspaceDisclosesHooks(`${ableTo} ${load}`)).toBe(false);
  expect(claudeWorkspaceDisclosesHooks(ableTo)).toBe(false);
});

test.each<readonly [string, string]>([
  ["wrapped at 100 columns", wrapped],
  ["unwrapped", wide],
  ...claudeHooksPromptCaptures,
])("C-CLAUDE-26 the probe leaves a hooks prompt to a human and reports it (%s)", (_, frame) => {
  expect(probeOutcome(frame)).toEqual(refusedOutcome("hooks_disclosed"));
});

test("C-CLAUDE-26 the probe still answers a plain workspace prompt from a Claude that discloses hooks", () => {
  expect(probeOutcome(claudeWorkspaceTrustScreen("/tmp/project"))).toMatchObject({
    outcomes: [{ outcome: { kind: "attempted", prompt: "workspace_trust" } }],
    refusals: [],
  });
});

test("C-CLAUDE-26 the probe leaves every workspace prompt to a human when Claude cannot disclose hooks", () => {
  expect(probeOutcome(claudeWorkspaceTrustScreen("/tmp/project"), false)).toEqual(
    refusedOutcome("hooks_undisclosable"),
  );
});

test.each([
  true,
  false,
])("C-CLAUDE-26 the probe does not refuse a workspace prompt whose copy is not verified before its budget runs out (can disclose: %s)", (canDiscloseHooks) => {
  const frame = wide.replace(` ${load}`, ` ${load}\n ${extra}`);
  expect(probeOutcome(frame, canDiscloseHooks)).toMatchObject({
    outcomes: [],
    writes: [],
    refusals: [],
  });
});
