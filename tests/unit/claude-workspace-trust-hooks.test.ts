/**
 * Claude 2.1.332's workspace prompt for a folder whose settings declare hooks: its exact
 * hooks rows are native copy, anything else in their place fails closed, and the model
 * probe's refusal leaves it to a human (PRD §5.3, §5.4, C-CLAUDE-26).
 */
import { expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { claudeWorkspaceDeclaresHooks } from "../../src/core/trust/copy.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";
import {
  claudeHooksPrompt,
  claudeWorkspaceTrustScreen,
  claudeHooksSettingsLoad as load,
  selectClaudeHooksYes,
  claudeHooksWarning as warning,
} from "../helpers/claude-workspace-trust-screen.ts";

const { wide, wrapped } = claudeHooksPrompt;
const ableTo = "Claude Code'll be able to read, edit, and execute files here.";
const likeYourOwn =
  " (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what's in this folder first.";
const extra = "Hooks also run on every prompt.";
const moveToYes = "\u001b[H\u001b[B";

/** Autotrust's answer to `frame` and its writes, re-rendered as Claude would after each. */
async function autotrustAnswer(frame: string) {
  const writes: string[] = [];
  let rendered = frame;
  const result = new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
    frame,
    (input) => {
      writes.push(input);
      rendered = input === moveToYes ? selectClaudeHooksYes(frame) : claudeComposer;
    },
    () => rendered,
  );
  const completion = result?.kind === "attempted" ? await result.settled : undefined;
  return { result, completion, writes };
}

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
  expect(await autotrustAnswer(frame)).toMatchObject(answered);
});

test("C-CLAUDE-26 autotrust answers the hooks prompt with only the closing explanation", async () => {
  const frame = wide.replace(likeYourOwn, "");
  expect(frame).not.toContain("Like your own code");
  expect(await autotrustAnswer(frame)).toMatchObject(answered);
});

test.each([
  ["the warning alone", [`\n\n ${load}`, ""]],
  ["the load row alone", [` ${warning}\n\n`, ""]],
  ["the rows reversed", [` ${warning}\n\n ${load}`, ` ${load}\n\n ${warning}`]],
  ["another settings file", [warning, warning.replace("settings.json", "settings.local.json")]],
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
  expect(claudeWorkspaceDeclaresHooks(`${ableTo} ${warning} ${load}`)).toBe(true);
  expect(claudeWorkspaceDeclaresHooks(`${ableTo} ${warning}`)).toBe(false);
  expect(claudeWorkspaceDeclaresHooks(`${ableTo} ${load}`)).toBe(false);
  expect(claudeWorkspaceDeclaresHooks(ableTo)).toBe(false);
});

/** A responder with automatic trust on whose hooks policy is the model probe's refusal. */
function probeResponder() {
  const refused = vi.fn();
  const responder = new ClaudeStartupPromptResponder(
    true,
    undefined,
    claudeTrustClearance,
    undefined,
    refused,
  );
  return { responder, refused };
}

test("C-CLAUDE-26 the probe's refusal leaves the hooks prompt to a human and reports it", () => {
  const { responder, refused } = probeResponder();
  const write = vi.fn();
  for (const frame of [wrapped, wide]) {
    expect(responder.handle(frame, write, () => frame)).toEqual([]);
  }
  expect(write).not.toHaveBeenCalled();
  expect(refused).toHaveBeenCalledTimes(2);
  expect(responder.humanOwnedPrompt).toBe("workspace_trust");
  responder.dispose();
});

test("C-CLAUDE-26 the probe's refusal still answers the plain workspace prompt", () => {
  const { responder, refused } = probeResponder();
  const frame = claudeWorkspaceTrustScreen("/tmp/project");
  const outcomes = responder.handle(
    frame,
    () => undefined,
    () => frame,
  );
  expect(outcomes).toMatchObject([{ outcome: { kind: "attempted", prompt: "workspace_trust" } }]);
  expect(refused).not.toHaveBeenCalled();
  responder.dispose();
});

test("C-CLAUDE-26 the probe's refusal ignores a hooks prompt whose copy is not verified", () => {
  const { responder, refused } = probeResponder();
  const frame = wide.replace(` ${load}`, ` ${load}\n ${extra}`);
  const write = vi.fn();
  expect(responder.handle(frame, write, () => frame)).toEqual([]);
  expect(refused).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  responder.dispose();
});
