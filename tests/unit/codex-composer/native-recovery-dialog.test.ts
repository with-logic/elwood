/** Captured native repaint protocol gates recovery and empty input (C-API-31/C-API-56). */
import { expect, test } from "vitest";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../../src/codex/screen/staged-input.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { nativeDialogs } from "../../fixtures/codex-native-dialog-renders.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

for (const payload of ["", "probe"]) {
  test.each(
    nativeDialogs,
  )(`C-API-31/C-API-56 captured $version $gate repaint with ${payload || "empty"} composer withholds both guards`, async ({
    paint,
  }) => {
    const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
    try {
      const frame = payload
        ? codexSmallComposer.replace("› Ask Codex to do anything", `› ${payload}`)
        : codexSmallComposer;
      const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
      await terminal.writeOutput(`${codexTty(frame)}\u001b[${row + 1};${payload.length + 3}H`);
      expect(codexInputStaged(terminal, "probe")).toBe(payload !== "");
      expect(codexEmptyInputFrame(terminal) !== undefined).toBe(payload === "");
      // Preserve the captured protocol order. These captures do not establish a
      // completed, visible partial dialog; controlled session cases cover that.
      const middle = Math.floor(paint.length / 2);
      for (const part of [
        "\u001b[?2026h",
        paint.slice(0, middle),
        paint.slice(middle),
        "\u001b[?25l",
        "\u001b[?2026l",
      ]) {
        await terminal.writeOutput(part);
        expect(codexInputStaged(terminal, "probe")).toBe(false);
        expect(codexEmptyInputFrame(terminal)).toBeUndefined();
      }
    } finally {
      terminal.dispose();
    }
  });
}
