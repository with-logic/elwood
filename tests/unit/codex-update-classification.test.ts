/** Exact-frame update classification is reused within its tracker (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import * as layout from "../../src/codex/update/layout.ts";

const options = "  1. Update now\n  2. Skip";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
