/** Real cursor captures and completed-render boundaries for C-TRUST-01. */
import { expect, test, vi } from "vitest";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { captures142 } from "../../fixtures/codex-cursor-142.ts";
import { captures155 } from "../../fixtures/codex-cursor-155.ts";

test.each([
  ...captures142,
  ...captures155,
])("C-TRUST-01 captured $stage at $cols×$rows", async (capture) => {
  const terminal = createHeadlessTerminal(capture, () => undefined);
  try {
    await terminal.writeOutput(
      `${capture.text.replaceAll("\n", "\r\n")}\u001b[${capture.cursorY + 1};${capture.cursorX + 1}H\u001b[?25${capture.visible ? "h" : "l"}\u001b]0;${capture.title}\u0007`,
    );
    const clear = liveCodexClearance(() => terminal);
    expect(clear(terminal.snapshot().text)).toBe(capture.clear);
    expect(clear("stale text from an earlier frame")).toBe(false);
    if (capture.clear) {
      await terminal.writeOutput("\u001b[4G");
      expect(clear(terminal.snapshot().text)).toBe(false);
      vi.spyOn(terminal.xterm, "write").mockImplementationOnce(() => {
        throw new Error("parser failed");
      });
      await expect(terminal.writeOutput("bad")).rejects.toThrow("parser failed");
      expect(clear(terminal.snapshot().text)).toBe(false);
    }
  } finally {
    terminal.dispose();
  }
});
