/** Codex 0.172 readiness waits for the requested effort's label on its footer (PRD §5.3, C-API-28). */
import { expect, test } from "vitest";
import { codexComposerConfigured } from "../../../src/codex/screen/clearance.ts";
import { classifyCodexFooter, codexFooterShowsEffort } from "../../../src/codex/screen/footer.ts";
import { codexReasoningEfforts } from "../../../src/core/reasoning-effort.ts";
import { codexPlanModeFooters172 } from "../../fixtures/codex-footer-captures-172.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const effortDefault = capturedFrame("codex-0.172.0/boot/effort-default");
const effortLow = capturedFrame("codex-0.172.0/boot/effort-low");
const cols = 140;

test("C-API-28 a requested effort holds readiness until Codex 0.172 shows it on the footer", () => {
  expect(codexComposerConfigured(effortDefault, cols)).toBe(true);
  expect(codexComposerConfigured(effortDefault, cols, "none")).toBe(true);
  expect(codexComposerConfigured(effortDefault, cols, "low")).toBe(false);
  expect(codexComposerConfigured(effortLow, cols, "low")).toBe(true);
});

test.each([
  ["a tier badge", "  GPT-6-Luna default fast"],
  ["no model", "  default · /tmp/elwood-boot-CAPTURE"],
])("C-API-28 a default footer with %s still holds a requested effort", (_shape, row) => {
  const frame = effortDefault.replace(/^ {2}GPT-6-Luna default$/m, row);
  expect(codexComposerConfigured(frame, cols)).toBe(true);
  expect(codexComposerConfigured(frame, cols, "low")).toBe(false);
});

test.each(
  codexPlanModeFooters172.map(({ cols, rows }) => ({ cols, frame: rows.join("\n") })),
)("C-API-28 a captured Plan-mode footer at $cols columns shows an applied effort", ({
  cols,
  frame,
}) => {
  expect(codexComposerConfigured(frame, cols, "low")).toBe(true);
});

test("C-API-28 the footer reports its effort label with or without a model", () => {
  const hint = "  ← for agents · ? for shortcuts";
  expect(classifyCodexFooter(["  GPT-6-Luna default", hint], cols)).toEqual({
    hasStatus: true,
    effortLabel: "default",
  });
  expect(classifyCodexFooter(["  high · ~/project", hint], cols)).toEqual({
    hasStatus: true,
    effortLabel: "high",
  });
  expect(classifyCodexFooter([hint], cols)).toEqual({ hasStatus: false });
  expect(classifyCodexFooter(["  high", hint], cols)).toBeUndefined();
});

test.each(codexReasoningEfforts)("C-API-28 Codex labels the requested effort %s", (effort) => {
  expect(codexFooterShowsEffort(effort)).toBe(effort !== "none");
});

test("C-API-28 no requested effort is labelled default", () => {
  expect(codexFooterShowsEffort(undefined)).toBe(false);
});
