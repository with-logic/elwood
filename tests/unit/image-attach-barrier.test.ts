/** Real emulator/adapter input boundaries for received-frame image safety (C-API-56). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { attachClaudeImages } from "../../src/claude/attach-images.ts";
import { attachCodexImages } from "../../src/codex/images/attach.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

vi.mock("../../src/codex/images/clipboard.ts", () => ({
  clipboardImageSupported: () => true,
  snapshotClipboardText: () => Promise.resolve("prior"),
  setClipboardImage: () => Promise.resolve(),
  restoreClipboardText: () => Promise.resolve(true),
}));
afterEach(() => vi.restoreAllMocks());

for (const [agent, attach, input] of [
  ["claude", attachClaudeImages, "\u001b[200~/image.png\u001b[201~"],
  ["codex", attachCodexImages, "\u0016"],
] as const) {
  for (const mode of ["dialog", "render failure", "abort"] as const) {
    test(`C-API-56 ${agent} image input waits for ${mode} at the physical terminal boundary`, async () => {
      const writes: string[] = [];
      const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, (data) => {
        writes.push(String(data));
        if (data === input) void terminal.writeOutput("\u001b[2J\u001b[H› [Image #1]");
      });
      await terminal.writeOutput("› ");
      const abort = new AbortController();
      const original = terminal.xterm.write.bind(terminal.xterm);
      let release = () => {};
      const render = vi.spyOn(terminal.xterm, "write");
      if (mode === "render failure") {
        render.mockImplementationOnce(() => {
          throw new Error("render failed");
        });
      } else {
        render.mockImplementationOnce((data, callback) => {
          release = () => original(data, callback);
        });
      }
      const paint = terminal.writeOutput("\u001b[2J\u001b[HAllow command?");
      const received =
        mode === "render failure" ? expect(paint).rejects.toThrow("render failed") : paint;
      await vi.waitFor(() => expect(render).toHaveBeenCalled());
      if (mode === "render failure") {
        await received;
        expect(terminal.renderFailed).toBe(true);
      } else {
        expect(terminal.snapshot().text).not.toContain("Allow command?");
      }
      const pending = attach(
        terminal,
        ["/image.png"],
        abort.signal,
        mode === "dialog" ? () => terminal.snapshot().text.includes("Allow command?") : undefined,
      );
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await setImmediate();
        expect(writes).toEqual([]);
        if (mode === "dialog") {
          release();
          await received;
          await new Promise((resolve) => setTimeout(resolve, 75));
          expect(writes).toEqual([]);
          await terminal.writeOutput("\u001b[2J\u001b[H› ");
          await expect(outcome).resolves.toBeUndefined();
          expect(writes).toEqual([input]);
        } else {
          if (mode === "abort") abort.abort();
          await expect(outcome).resolves.toMatchObject({ code: "image_attach_failed" });
          expect(writes).toEqual([]);
        }
      } finally {
        abort.abort();
        release();
        await received;
        await outcome;
        terminal.dispose();
      }
    });
  }
}
