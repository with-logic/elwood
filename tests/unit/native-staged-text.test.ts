/** Captured idle draft geometry remains eligible; active/history/unknown frames do not (C-API-31). */
import { expect, test } from "vitest";
import { claudeTextStaged } from "../../src/claude/composer/staged-text.ts";
import { codexTextStaged } from "../../src/codex/screen/staged-text.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import {
  claudeComposer,
  claudeTty,
  codexSmallComposer,
  codexTty,
} from "../fixtures/trust-composer.ts";

const payloads = ["first\nlast word", `ELWOOD_WRAP ${"word ".repeat(40)}FINAL`, "ELWOOD_LINE_17"];
for (const agent of ["claude", "codex"] as const) {
  for (const index of agent === "claude" ? [2] : [0, 1, 2]) {
    test(`C-API-31 ${agent} captured staged text ${index} retains native cursor geometry`, async () => {
      const version = agent === "claude" ? "2.1.281" : "0.156.1";
      const frame = readNativeInputFrame(
        new URL(`../fixtures/${agent}-${version}/staged-text-${index}.json`, import.meta.url),
      );
      expect([0, 1]).toContain(frame.baseY);
      const terminal = createHeadlessTerminal(
        { cols: frame.cols, rows: frame.rows },
        () => undefined,
      );
      try {
        await terminal.writeOutput(`\u001b[${frame.rows};1H${frame.baseY === 1 ? "\r\n" : ""}`);
        await terminal.writeOutput(
          `\u001b[2J\u001b[H${frame.text.replaceAll("\n", "\r\n")}\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H\u001b[?25${frame.visible ? "h" : "l"}\u001b]0;${frame.title}\u0007`,
        );
        terminal.xterm.scrollToLine(frame.viewportY);
        expect(terminal.xterm.buffer.active.baseY).toBe(frame.baseY);
        expect(terminal.xterm.buffer.active.viewportY).toBe(frame.viewportY);
        expect(terminal.snapshot().cursorY).toBe(frame.cursorY);
        expect(
          (agent === "claude" ? claudeTextStaged : codexTextStaged)(terminal, payloads[index]!),
        ).toBe(true);
        if (agent === "claude") {
          // The exact staged footer remains chrome when history has scrolled the version away.
          await terminal.writeOutput("\u001b[1;1H\u001b[2K");
          await terminal.writeOutput(`\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H`);
          expect(claudeTextStaged(terminal)).toBe(true);
        }
      } finally {
        terminal.dispose();
      }
    });
  }
  test(`C-API-31 ${agent} rejects ineligible native draft frames`, async () => {
    const terminal = createHeadlessTerminal({ cols: 200, rows: 35 }, () => undefined);
    const match = () =>
      (agent === "claude" ? claudeTextStaged : codexTextStaged)(terminal, "draft");
    const caret = agent === "claude" ? "❯" : "›";
    const payload = agent === "claude" ? "[Pasted text #1 +3 lines]" : "draft";
    const idle = agent === "claude" ? claudeComposer : codexSmallComposer;
    const draft = idle.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} ${payload}`);
    const paint = (text = draft, cursor = "", title = "Ready") =>
      terminal.writeOutput(
        `\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(text)}${cursor}\u001b]0;${title}\u0007`,
      );
    try {
      expect(match()).toBe(false);
      await paint();
      expect(match()).toBe(true);
      await paint(draft.replace(`${caret} ${payload}`, `${caret}${payload}`));
      expect(match()).toBe(false);
      await paint(draft, "\u001b[2G");
      expect(match()).toBe(false);
      await paint(draft, "\u001b[?25l");
      expect(match()).toBe(false);
      await paint(draft, "", "⠋ Working");
      expect(match()).toBe(false);
      await paint(`Do you want to create probe.txt?\n${draft}\n  1. Yes\n  3. No\nEsc to cancel`);
      expect(match()).toBe(false);
      await paint(`${draft}\nUnknown footer: continue?`);
      expect(match()).toBe(false);
      await paint(`${caret} ${payload}`);
      expect(match()).toBe(false);
      await paint(`${caret} ${payload}\n${idle}`);
      expect(match()).toBe(false);
      await paint(draft.replace(caret, " "));
      expect(match()).toBe(false);
      await paint(draft, "\u001b[?2026h");
      expect(match()).toBe(false);
      await terminal.writeOutput("\u001b[?2026l");
      expect(match()).toBe(true);
      await terminal.writeOutput(`\u001b[35;1H${"\r\n".repeat(40)}\u001b[3G`);
      terminal.xterm.scrollToTop();
      expect(match()).toBe(false);
      if (agent === "codex") {
        await terminal.writeOutput("\u001bc");
        await paint(idle);
        expect(codexTextStaged(terminal, "anything")).toBe(false);
        await paint(idle, "\u001b[28G");
        expect(codexTextStaged(terminal, "anything")).toBe(true);
        expect(codexTextStaged(terminal, " \t\n")).toBe(false);
        const malformed = draft.replace(`${caret} draft`, `${caret} first\nnot indented`);
        const row = malformed.split("\n").indexOf("not indented");
        await paint(malformed, `\u001b[${row + 1};3H`);
        expect(match()).toBe(false);
      }
    } finally {
      terminal.dispose();
    }
  });
}
