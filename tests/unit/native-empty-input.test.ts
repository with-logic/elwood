/** Native active input can be empty without proving idle/trust clearance (C-API-56). */
import { expect, test } from "vitest";
import { claudeEmptyInputFrame } from "../../src/claude/composer/empty-input.ts";
import { liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { codexEmptyInputFrame } from "../../src/codex/screen/empty-input.ts";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { settledCursorVisible } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-56 ${agent} observes native empty working input while retaining strict clearance`, async () => {
    const version = agent === "claude" ? "2.1.281" : "0.156.1";
    const fixture = readNativeInputFrame(
      new URL(`../fixtures/${agent}-${version}/working-empty-input.json`, import.meta.url),
    );
    const terminal = createHeadlessTerminal(
      { cols: fixture.cols, rows: fixture.rows },
      () => undefined,
    );
    const observe = agent === "claude" ? claudeEmptyInputFrame : codexEmptyInputFrame;
    const clearance = (agent === "claude" ? liveClaudeClearance : liveCodexClearance)(
      () => terminal,
    );
    const caret = agent === "claude" ? "❯" : "›";
    const paint = async (text: string) => {
      await terminal.writeOutput(
        `\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}\u001b[${fixture.cursorY + 1};${fixture.cursorX + 1}H\u001b[?25${fixture.visible ? "h" : "l"}\u001b]0;${fixture.title}\u0007`,
      );
    };
    try {
      expect(observe(terminal)).toBeUndefined();
      // Reject oversized capture offsets before allocating replay input.
      expect(fixture.baseY).toBeLessThanOrEqual(10_000);
      await terminal.writeOutput(
        `\u001b[${fixture.rows};1H${"\r\n".repeat(Math.min(fixture.baseY, 10_000))}`,
      );
      await paint(fixture.text);
      terminal.xterm.scrollToLine(fixture.viewportY);
      expect(terminal.xterm.buffer.active.baseY).toBe(fixture.baseY);
      expect(terminal.xterm.buffer.active.viewportY).toBe(fixture.viewportY);
      expect(settledCursorVisible(terminal.xterm)).toBe(fixture.visible);
      expect(terminal.snapshot().cursorX).toBe(fixture.cursorX);
      expect(terminal.snapshot().cursorY).toBe(fixture.cursorY);
      const accepted = observe(terminal);
      expect(accepted).toBeDefined();
      expect(observe(terminal)).toBe(accepted);
      expect(clearance(terminal.snapshot().text)).toBe(false);
      for (const content of ["[Image #1]", "unsubmitted text", "1. Continue"]) {
        const rows = fixture.text.split("\n");
        rows[fixture.cursorY] = `${caret} ${content}`;
        await paint(rows.join("\n"));
        expect(observe(terminal)).toBeUndefined();
      }
      if (agent === "claude") {
        for (const row of [fixture.cursorY - 1, fixture.cursorY + 1]) {
          const incomplete = fixture.text.split("\n");
          incomplete[row] = "";
          await paint(incomplete.join("\n"));
          expect(observe(terminal)).toBeUndefined();
        }
        // Existing banner/fence grammar and documented 2.1.268 non-Vim footer.
        for (const footer of ["", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"]) {
          const rows = fixture.text.split("\n");
          rows[fixture.cursorY + 2] = footer;
          await paint(rows.join("\n"));
          expect(observe(terminal)).toBeDefined();
        }
        const noBanner = fixture.text.split("\n");
        noBanner[0] = "";
        await paint(noBanner.join("\n"));
        expect(observe(terminal)).toBeDefined();
        noBanner[fixture.cursorY + 2] = "";
        await paint(noBanner.join("\n"));
        expect(observe(terminal)).toBeUndefined();
        await terminal.writeOutput("\u001b[2J\u001b[H❯ \u001b[1;3H");
        expect(observe(terminal)).toBeUndefined();
        await terminal.writeOutput(`\u001b[${fixture.rows - 1};1H────\r\n❯ \u001b[3G`);
        expect(observe(terminal)).toBeUndefined();
      }
      const overlay = fixture.text.split("\n");
      overlay[fixture.cursorY + 4] = "  Unknown replacement: continue?";
      await paint(overlay.join("\n"));
      expect(observe(terminal)).toBeUndefined();
      await paint(fixture.text);
      await terminal.writeOutput("\u001b[?25l");
      expect(observe(terminal)).toBeUndefined();
      await terminal.writeOutput("\u001b[?25h\u001b[4G");
      expect(observe(terminal)).toBeUndefined();
      await terminal.writeOutput("\u001b[3G\u001b[?2026h");
      expect(observe(terminal)).toBeUndefined();
      await terminal.writeOutput("\u001b[?2026l");
      expect(observe(terminal)).toBeDefined();
      expect(observe(terminal)).not.toBe(accepted);
      // Scroll the viewport one row above the live buffer, keeping input in view.
      await terminal.writeOutput(`\u001b[${fixture.rows};1H\r\n`);
      await paint(fixture.text);
      const base = terminal.xterm.buffer.active.baseY;
      terminal.xterm.scrollToLine(base - 1);
      expect(terminal.xterm.buffer.active.baseY - terminal.xterm.buffer.active.viewportY).toBe(1);
      expect(observe(terminal)).toBeDefined();
      await terminal.writeOutput(`${"\r\n".repeat(40)}\u001b[3G`);
      terminal.xterm.scrollToTop();
      expect(observe(terminal)).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });
}
