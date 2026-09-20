/** Native composer provenance keeps trust-owned input held (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { codexTrustClearance } from "../../../src/codex/screen-table.ts";
import { CodexStartupPromptResponder } from "../../../src/codex/startup-prompts.ts";
import { TrustPromptResponder } from "../../../src/core/trust/responder.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { codexComposer, codexTrust, codexTty, tty } from "../../fixtures/trust-composer.ts";

afterEach(() => vi.useRealTimers());

test.each([
  codexComposer.replace("› Ask", "• Working (3s • esc to interrupt)\n› Ask"),
  "• A quoted example:\n  › Implement {feature}\n  gpt-5.5 high",
])("C-TRUST-01 a held generation survives active work and quoted chrome: %s", (frame) => {
  vi.useFakeTimers();
  const responder = new TrustPromptResponder("codex", codexTrustClearance, true);
  const write = vi.fn();
  try {
    responder.handle("Do you trust the contents of this directory?", write);
    expect(responder.inputBlocking).toBe(true);
    responder.handle(frame, write);
    expect(responder.inputBlocking).toBe(true);
    expect(write).not.toHaveBeenCalled();
    responder.handle(codexComposer, write);
    expect(responder.inputBlocking).toBe(false);
    expect(write).not.toHaveBeenCalled();
  } finally {
    responder.dispose();
  }
});

test("C-TRUST-01 live trust revalidation includes title-only working evidence", async () => {
  vi.useFakeTimers();
  const terminal = createHeadlessTerminal({ cols: 200, rows: 30 }, () => undefined);
  const frame = `${codexTrust}\n› 1. Yes, continue\n  2. No, quit`;
  const responder = new CodexStartupPromptResponder(
    "s",
    true,
    undefined,
    liveCodexClearance(() => terminal),
  );
  try {
    const initial = terminal.writeOutput(tty(frame));
    await vi.advanceTimersByTimeAsync(5);
    await initial;
    const { outcomes } = responder.handle(
      terminal.snapshot().text,
      () =>
        terminal.writeOutput(`\u001b]0;⠋ project\u0007\u001b[2J\u001b[H${codexTty(codexComposer)}`),
      () => terminal.snapshot().text,
    );
    await vi.advanceTimersByTimeAsync(250);
    await expect(outcomes[0]?.settled).resolves.toBe("cancelled");
    expect(responder.inputBlocking).toBe(true);
    const idle = terminal.writeOutput("\u001b]0;project\u0007");
    await vi.advanceTimersByTimeAsync(5);
    await idle;
    responder.handle(terminal.snapshot().text, vi.fn());
    expect(responder.inputBlocking).toBe(false);
  } finally {
    responder.dispose();
    terminal.dispose();
  }
});
