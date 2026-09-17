/** Native explanatory copy is positive trust evidence; foreign prose is not (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import * as dialog from "../../src/core/trust/dialog.ts";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";

afterEach(() => vi.restoreAllMocks());

// Native strings from the installed codex 0.144.4 executable; no agent turn required.
const directory = [
  "> You are in /Users/example/a project",
  "Do you trust the contents of this directory?",
  "Working with untrusted contents comes with higher risk of prompt injection.",
  "Trusting the directory allows project-local config, hooks, and exec policies to load.",
  "› 1. Yes, continue",
  "  2. No, quit",
  "Press enter to continue",
].join("\n");
const hooks = [
  "Hooks need review",
  "2 hooks are new or changed.",
  "Hooks can run outside the sandbox after you trust them.",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks won't run)",
].join("\n");

test.each([
  [directory, true, "workspace_trust", "1\r"],
  [hooks, false, "hook_trust", "2\r"],
] as const)("C-TRUST-01 preserves native Codex trust explanation: %s", (frame, trust, label, key) => {
  const writes: string[] = [];
  const result = new TrustPromptResponder("codex", trust).handle(frame, (input) => {
    writes.push(input);
  });
  expect(result).toMatchObject({ kind: "answered", automation: { prompt: label } });
  expect(writes).toEqual([key]);
  expect(trustPromptVisible(frame, "codex")).toBe(true);
});

test.each([
  "Do you trust the contents of this directory?\nEnable elevated access\n1. Yes, continue",
  "Hooks need review\nUnknown safety migration\n1. Trust all and continue",
  directory.replace("› 1.", "Unrecognized confirmation\n› 1."),
  hooks.replace("› 1.", "This unrelated change needs approval\n› 1."),
  "Hooks need review\n  Enable elevated execution\n❯ Trust all and continue",
])("C-TRUST-01 foreign prose cannot borrow native trust authority: %s", (frame) => {
  const write = vi.fn();
  expect(new TrustPromptResponder("codex", true).handle(frame, write)).toBeUndefined();
  expect(trustPromptVisible(frame, "codex")).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

test("C-CLAUDE-14 the native MCP title admits its server name, not arbitrary trailing prose", () => {
  // Native title from the installed Claude 2.1.274 executable, with a config server key.
  const native = "New MCP server found in this project: github\n1. Use this MCP server";
  expect(trustPromptVisible(native, "claude")).toBe(true);
  expect(
    trustPromptVisible(native.replace(": github", ": github Unknown migration"), "claude"),
  ).toBe(false);
});

test("C-TRUST-01 all blocking trust classes share one parsed viewport", () => {
  const parse = vi.spyOn(dialog, "parseTrustDialog");
  const table = claudeScreenFactTableForTrustPolicy(false);
  const frame = { text: "Load this skill?\n1. Yes\n2. No", title: "" };
  expect(readScreenFacts(table, frame).facts.blocking_prompt_visible).toBe(true);
  expect(parse).toHaveBeenCalledTimes(1);
  readScreenFacts(table, frame);
  expect(parse).toHaveBeenCalledTimes(1);
  readScreenFacts(table, { text: "Ready", title: "" });
  expect(parse).toHaveBeenCalledTimes(2);
});

test("C-TRUST-01 visibility and recognition parse once before comparing eligible classes", () => {
  const parse = vi.spyOn(dialog, "parseTrustDialog");
  const frame = "Hooks need review";
  expect(trustPromptVisible(frame, "codex")).toBe(true);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(new TrustPromptResponder("codex").handle(frame, vi.fn())).toMatchObject({
    kind: "option_pending",
  });
  expect(parse).toHaveBeenCalledTimes(2);
});
