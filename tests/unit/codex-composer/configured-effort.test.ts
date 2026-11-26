/** Codex 0.172 readiness waits for the requested effort on its footer (PRD §5.3, C-API-28). */
import { expect, test } from "vitest";
import { codexComposerConfigured } from "../../../src/codex/screen/clearance.ts";
import { classifyCodexFooter } from "../../../src/codex/screen/footer.ts";
import { codexFooterShowsEffort } from "../../../src/codex/session/readiness.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const unconfigured = capturedFrame("codex-0.172.0/boot/unconfigured-effort");
const configured = capturedFrame("codex-0.172.0/boot/configured-effort");
const cols = 140;

test("C-API-28 a requested effort holds readiness until Codex 0.172 shows it on the footer", () => {
  expect(codexComposerConfigured(unconfigured, cols)).toBe(true);
  expect(codexComposerConfigured(unconfigured, cols, true)).toBe(false);
  expect(codexComposerConfigured(configured, cols, true)).toBe(true);
});

test("C-API-28 any effort label but default shows the configuration landed", () => {
  const plan = configured.replace(
    /^ {2}GPT-6-Luna low$/m,
    "  GPT-6-Luna medium  Plan mode (⇧tab to cycle)",
  );
  expect(codexComposerConfigured(plan, cols, true)).toBe(true);
});

test("C-API-28 the footer reports its effort label with or without a model", () => {
  const hint = "  ← for agents · ? for shortcuts";
  expect(classifyCodexFooter(["  GPT-6-Luna default", hint], cols)).toEqual({
    hasStatus: true,
    effort: "default",
  });
  expect(classifyCodexFooter(["  high · ~/project", hint], cols)).toEqual({
    hasStatus: true,
    effort: "high",
  });
  expect(classifyCodexFooter([hint], cols)).toEqual({ hasStatus: false, effort: undefined });
  expect(classifyCodexFooter(["  high", hint], cols)).toBeUndefined();
});

test("C-API-28 only an effort Codex labels can prove the configuration landed", () => {
  expect(codexFooterShowsEffort(undefined)).toBe(false);
  expect(codexFooterShowsEffort("none")).toBe(false);
  expect(codexFooterShowsEffort("low")).toBe(true);
});
