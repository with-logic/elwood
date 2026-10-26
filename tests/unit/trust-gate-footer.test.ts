/**
 * Codex 0.164's gate-bound footers end a dialog only under the allowlisted gate that draws
 * it: never under the other gate, and never in conversation text (PRD §5.4, C-CODEX-15).
 */
import { describe, expect, test, vi } from "vitest";
import {
  codexScreenFactTableForTrustPolicy,
  codexTrustClearance,
} from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { trustGateVisible } from "../../src/core/trust/blocking.ts";
import { TrustPromptResponder, trustPromptVisible } from "../../src/core/trust/responder.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const folder = capturedFrame("codex-0.164.0/trust/folder-access-no-hook-bypass");
const hooks = capturedFrame("codex-0.164.0/trust/hooks-no-hook-bypass");
const folderFooter = "enter continue · esc back";
const hooksFooter = "enter confirm · esc skip";

const blockingRuleIds = (autotrust: boolean, text: string) =>
  readScreenFacts(codexScreenFactTableForTrustPolicy(autotrust), { text, title: "" })
    .matched.filter((rule) => rule.fact === "blocking_prompt_visible")
    .map((rule) => rule.id);

test.each([
  ["folder access with the hooks footer", folder.replace(folderFooter, hooksFooter)],
  ["hooks with the folder-access footer", hooks.replace(hooksFooter, folderFooter)],
])("C-CODEX-15 a Codex 0.164 gate footer counts only under its own gate: %s", (_, frame) => {
  expect(trustView(frame, "codex", codexTrustClearance)).toMatchObject({
    kind: "candidate",
    valid: false,
    option: undefined,
  });
  expect(trustPromptVisible(frame, "codex")).toBe(false);
  const write = vi.fn();
  expect(
    new TrustPromptResponder("codex", codexTrustClearance, true).handle(frame, write),
  ).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

// An agent reply whose `•` row has scrolled off the viewport: no conversation row marks
// these rows, so only the footer's binding to its own gate keeps them from reading as one.
const reply = (footer: string) =>
  `  Do you want me to keep going?\n  1. Keep going\n  2. Stop here\n\n  ${footer}`;

describe.each([true, false])("autotrust %s", (autotrust) => {
  test.each([
    folderFooter,
    hooksFooter,
  ])("C-CODEX-15 the gate footer %s in conversation text is no trust gate", (footer) => {
    for (const frame of [reply(footer), `• The dialog read:\n${reply(footer)}`]) {
      expect(trustView(frame, "codex", codexTrustClearance)).toEqual({ kind: "unknown" });
      expect(trustGateVisible(frame, "codex")).toBe(false);
      expect(blockingRuleIds(autotrust, frame)).toEqual([]);
      const write = vi.fn();
      new TrustPromptResponder("codex", codexTrustClearance, autotrust).handle(frame, write);
      expect(write).not.toHaveBeenCalled();
    }
  });
});
