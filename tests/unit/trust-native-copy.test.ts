/** Native explanatory copy is positive trust evidence; foreign prose is not (C-TRUST-01). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import * as dialog from "../../src/core/trust/dialog.ts";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";
import { codexHooks } from "../fixtures/trust-composer.ts";

const directory = readFileSync(
  new URL("../fixtures/codex-0.154.0/directory.txt", import.meta.url),
  "utf8",
);
const hooks = readFileSync(new URL("../fixtures/codex-0.154.0/hooks.txt", import.meta.url), "utf8");

afterEach(() => vi.restoreAllMocks());

test.each([
  [directory, true, "workspace_trust", "1\r"],
  [hooks, false, "hook_trust", "2\r"],
] as const)("C-TRUST-01 preserves native Codex trust explanation: %s", (frame, trust, label, key) => {
  const writes: string[] = [];
  const result = new TrustPromptResponder("codex", codexTrustClearance, trust).handle(
    frame,
    (input) => {
      writes.push(input);
    },
  );
  expect(result).toMatchObject({ kind: "attempted", automation: { prompt: label } });
  expect(writes).toEqual([key]);
  expect(trustPromptVisible(frame, "codex")).toBe(true);
});

test.each([
  "Do you trust the contents of this directory?\nEnable elevated access\n1. Yes, continue",
  "Hooks need review\nUnknown safety migration\n1. Trust all and continue",
  directory.replace("› 1.", "Unrecognized confirmation\n› 1."),
  hooks.replace("› 1.", "This unrelated change needs approval\n› 1."),
  `${codexHooks}\n  Enable elevated execution\n❯ Trust all and continue`,
])("C-TRUST-01 foreign prose cannot borrow native trust authority: %s", (frame) => {
  const write = vi.fn();
  expect(
    new TrustPromptResponder("codex", codexTrustClearance, true).handle(frame, write),
  ).toBeUndefined();
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
  const parse = vi.spyOn(dialog, "parseTrustCandidates");
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
  const frame = codexHooks;
  expect(trustPromptVisible(frame, "codex")).toBe(true);
  expect(parse).toHaveBeenCalledTimes(1);
  const parseCandidate = vi.spyOn(dialog, "parseTrustCandidates");
  expect(
    new TrustPromptResponder("codex", codexTrustClearance).handle(frame, vi.fn()),
  ).toMatchObject({
    kind: "option_pending",
  });
  expect(parseCandidate).toHaveBeenCalledTimes(1);
});
