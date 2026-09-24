/** Exact-frame update classification is reused within its tracker (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import * as layout from "../../src/codex/update/layout.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { codexOptionStillSafe } from "../../src/codex/update-prompt.ts";

const options = "  1. Update now\n  2. Skip";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("C-CODEX-12 a tracker retains only its most recent exact classification", () => {
  const parse = vi.spyOn(layout, "updateDialogOptions");
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(options);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
  expect(parse).toHaveBeenCalledTimes(1);
  const replacement = `${options}\nConfirm archive removal?`;
  expect(tracker.classify(replacement).options).toBeUndefined();
  expect(parse).toHaveBeenCalledTimes(2);
  expect(tracker.currentFramePredicate()(replacement)).toBe(false);
  expect(parse).toHaveBeenCalledTimes(2);
  tracker.classify(options);
  expect(parse).toHaveBeenCalledTimes(3);
  new CodexUpdatePromptTracker().classify(options);
  expect(parse).toHaveBeenCalledTimes(4);
});

test("C-CODEX-12 responder selection reuses its tracker's current classification", async () => {
  const parse = vi.spyOn(layout, "updateDialogOptions");
  const responder = new CodexStartupPromptResponder("classification");
  const write = vi.fn();
  const result = responder.handle(options, write);
  await result.outcomes[0]?.settled;
  expect(write).toHaveBeenCalledExactlyOnceWith("2", expect.any(Function));
  expect(parse).toHaveBeenCalledTimes(1);
  responder.dispose();
});

test("C-CODEX-12 settled-key safety computes one local classification", () => {
  const parse = vi.spyOn(layout, "updateDialogOptions");
  expect(codexOptionStillSafe(options, "2")).toBe(true);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(codexOptionStillSafe(`${options}\nConfirm archive removal?`, "2")).toBe(false);
  expect(parse).toHaveBeenCalledTimes(2);
});

test("C-CODEX-12 retries reuse one classification while the exact frame persists", async () => {
  vi.useFakeTimers();
  const parse = vi.spyOn(layout, "updateDialogOptions");
  const responder = new CodexStartupPromptResponder("classification");
  const write = vi.fn();
  const result = responder.handle(options, write, () => options);
  await vi.runAllTimersAsync();
  await expect(result.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledTimes(20);
  expect(parse).toHaveBeenCalledTimes(1);
  responder.dispose();
});
