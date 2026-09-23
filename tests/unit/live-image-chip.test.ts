/** Live image recovery excludes history and unobserved input surfaces (C-API-44). */
import { expect, test } from "vitest";
import { claudeImageStaged } from "../../src/claude/composer/image-staged.ts";
import { codexImageStaged } from "../../src/codex/screen/image-staged.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import {
  claudeComposer,
  claudeTty,
  codexSmallComposer,
  codexTty,
} from "../fixtures/trust-composer.ts";

for (const agent of ["claude", "codex"] as const) {
  test(`C-API-44 ${agent} image recovery requires live idle composer geometry`, async () => {
    const terminal = createHeadlessTerminal({ cols: 200, rows: 35 }, () => undefined);
    const staged = agent === "claude" ? claudeImageStaged : codexImageStaged;
    const caret = agent === "claude" ? "❯" : "›";
    const empty = agent === "claude" ? claudeComposer : codexSmallComposer;
    const draft = empty.replace(new RegExp(`^${caret}.*$`, "m"), `${caret} [Image #1]`);
    const paint = async (text: string) =>
      terminal.writeOutput(`\u001b[2J\u001b[H${(agent === "claude" ? claudeTty : codexTty)(text)}`);
    try {
      expect(staged(terminal)).toBe(false);
      await paint(draft);
      expect(staged(terminal)).toBe(true);
      await terminal.writeOutput("\u001b]0;⠋ Working\u0007");
      expect(staged(terminal)).toBe(false); // title alone revokes otherwise unchanged input
      await terminal.writeOutput("\u001b]0;✳ Ready\u0007\u001b[?25l");
      expect(staged(terminal)).toBe(false);
      await terminal.writeOutput("\u001b[?25h\u001b[2G");
      expect(staged(terminal)).toBe(false);
      await terminal.writeOutput("\u001b[3G\u001b[?2026h");
      expect(staged(terminal)).toBe(false);
      await terminal.writeOutput("\u001b[?2026l\u001b[1;3H");
      expect(staged(terminal)).toBe(false);
      await paint(empty);
      expect(staged(terminal)).toBe(false);
      await paint(`${caret} [Image #1]`);
      expect(staged(terminal)).toBe(false); // no native chrome
      await paint(`${caret} [Image #1]\n${empty}`);
      expect(staged(terminal)).toBe(false); // submitted history above empty input
      await terminal.writeOutput(`${"\r\n".repeat(80)}\u001b[3G`);
      terminal.xterm.scrollToTop();
      expect(staged(terminal)).toBe(false);
    } finally {
      terminal.dispose();
    }
  });
}
