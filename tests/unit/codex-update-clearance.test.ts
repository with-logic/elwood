/** Positive update settlement evidence and quiet cancellation (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { writeCodexUpdateSkip } from "../../src/codex/update-prompt.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";

const update = "Update available! 0.151.0 -> 0.152.0\n1. Update now\n2. Skip";
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 a completed write without a reader is not an answered update", async () => {
  const write = vi.fn();
  await expect(writeCodexUpdateSkip("2", write)).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledOnce();
});

test.each([
  "",
  "› Ready",
  "Confirm removal?\n❯ Proceed\n  Cancel",
])("C-CODEX-12 replacement %j cannot report success after a digit", async (replacement) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder();
  let frame = update;
  const write = vi.fn(() => {
    frame = replacement;
  });
  const result = responder.handle(frame, write, () => frame);
  responder.handle(frame, write, () => frame);
  await vi.runAllTimersAsync();
  await expect(result.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledOnce();
  responder.dispose();
});

test.each([
  "visible",
  "hidden",
  "unobserved-hidden",
  "unobserved-recovery",
  "working",
  "synchronized",
  "pending",
])("C-CODEX-12 native %s composer controls update completion", async (state) => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const clearance = liveCodexClearance(() => terminal);
  const responder = new CodexStartupPromptResponder("s1", false, undefined, clearance);
  try {
    await terminal.writeOutput(update.replaceAll("\n", "\r\n"));
    const read = () => terminal.snapshot().text;
    const write = vi.fn();
    const result = responder.handle(read(), write, read);
    const suffix =
      state.includes("hidden") || state === "unobserved-recovery"
        ? "\u001b[?25l"
        : state === "working"
          ? "\u001b]0;⠋ Working\u0007"
          : state === "synchronized"
            ? "\u001b[?2026h"
            : "";
    await terminal.writeOutput(`\u001b[2J\u001b[H${codexTty(codexSmallComposer)}${suffix}`);
    const pending = state === "pending" ? terminal.writeOutput("\u001b[?25l") : undefined;
    if (state !== "unobserved-hidden") responder.handle(read(), write, read);
    if (state === "unobserved-recovery") await terminal.writeOutput("\u001b[?25h");
    await expect(result.outcomes[0]?.settled).resolves.toBe(
      state === "visible" ? "answered" : "cancelled",
    );
    expect(write).toHaveBeenCalledOnce();
    await pending;
  } finally {
    responder.dispose();
    terminal.dispose();
  }
});

test("C-CODEX-12 a direct writer confirms positive composer clearance after its digit", async () => {
  vi.useFakeTimers();
  let frame = update;
  const write = vi.fn(() => {
    frame = codexSmallComposer;
  });
  const settled = writeCodexUpdateSkip("2", write, () => frame);
  await vi.runAllTimersAsync();
  await expect(settled).resolves.toBe("answered");
  expect(write).toHaveBeenCalledOnce();
});
