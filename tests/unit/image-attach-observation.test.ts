/** Image observation owns the baseline and releases failed clipboard leases (C-API-44/46/56). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachClaudeImages } from "../../src/claude/attach-images.ts";
import { attachCodexImages } from "../../src/codex/images/attach.ts";

vi.mock("../../src/codex/images/clipboard.ts", () => ({
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("prior"),
  setClipboardImage: () => Promise.resolve(),
  restoreClipboardText: () => Promise.resolve(true),
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

for (const [agent, attach] of [
  ["claude", attachClaudeImages],
  ["codex", attachCodexImages],
] as const) {
  for (const repaint of ["adds old chip", "clears old chip"] as const) {
    test(`C-API-44 ${agent} uses the observed baseline when pending output ${repaint}`, async () => {
      const rendered = Promise.withResolvers<void>();
      let text = repaint === "adds old chip" ? "› " : "› [Image #1]";
      const terminal = {
        settled: () => rendered.promise,
        renderFailed: false,
        snapshot: () => ({ text }),
        sendInput: vi.fn(() => {
          // A failed new paste adds nothing; a successful one paints a fresh chip.
          if (repaint === "clears old chip") text = "› [Image #1]";
        }),
      };
      const pending = attach(terminal, ["/image.png"], new AbortController().signal);
      const outcome = pending.then(
        () => "confirmed",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(terminal.sendInput).not.toHaveBeenCalled();
      text = repaint === "adds old chip" ? "› [Image #1]" : "› ";
      rendered.resolve();
      await vi.runAllTimersAsync();
      if (repaint === "adds old chip")
        expect(await outcome).toMatchObject({ code: "image_attach_failed" });
      else expect(await outcome).toBe("confirmed");
    });
  }
}

test("C-API-46 a failed render releases the clipboard for another open session", async () => {
  const failedSession = new AbortController();
  const terminal = {
    settled: () => Promise.resolve(),
    renderFailed: true,
    snapshot: () => ({ text: "› " }),
    sendInput: vi.fn(),
  };
  let failed: unknown;
  const first = attachCodexImages(terminal, ["/failed.png"], failedSession.signal).catch(
    (error: unknown) => {
      failed = error;
    },
  );
  let chip = "› ";
  const nextTerminal = {
    settled: () => Promise.resolve(),
    renderFailed: false,
    snapshot: () => ({ text: chip }),
    sendInput: vi.fn(() => {
      chip = "› [Image #1]";
    }),
  };
  let complete = false;
  const second = attachCodexImages(nextTerminal, ["/next.png"], new AbortController().signal).then(
    () => {
      complete = true;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(failed).toMatchObject({ code: "image_attach_failed" });
    expect(failedSession.signal.aborted).toBe(false);
    expect(terminal.sendInput).not.toHaveBeenCalled();
    expect(complete).toBe(true);
    expect(nextTerminal.sendInput).toHaveBeenCalledExactlyOnceWith("\u0016");
  } finally {
    failedSession.abort();
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
  }
});
