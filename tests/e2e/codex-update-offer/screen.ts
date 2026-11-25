/**
 * The CLI's own screen for the update-offer input guard, drawn from its raw output by a
 * terminal of the harness rather than read from Elwood's rendering, and what the guard
 * reads on it (PRD §12, C-E2E-26, C-E2E-27).
 */

import xtermHeadless from "@xterm/headless";
import type { TerminalSize } from "../../../src/core/types.ts";

const { Terminal } = xtermHeadless;

/** One application write that was kept from the CLI, with the CLI's screen it was aimed at. */
export type RefusedInput = { readonly data: string; readonly screen: string };

/** The digit of the offer's plain `Skip` row, or undefined while no `N. Update now` row shows. */
export function offerSkipDigit(screen: string): string | undefined {
  if (!/^\s*›?\s*\d+\. Update now\b/m.test(screen)) return undefined;
  return /^\s*›?\s*(\d+)\. Skip\s*$/m.exec(screen)?.[1];
}

/** Codex's configured composer: a composer row over a footer naming the model and directory. */
export function configuredComposerShown(screen: string): boolean {
  const rows = screen.split("\n");
  const at = rows.findLastIndex((row) => /^›(?:\s|$)/.test(row));
  return at >= 0 && rows.slice(at + 1).some((row) => /^\s+\S.* · [~/…]/.test(row));
}

/** Each refused write with the marked rows of the screen it met, to show on failure. */
export function refusedAtMarkedRows(refused: readonly RefusedInput[]) {
  return refused.map(({ data, screen }) => ({
    data,
    marked: screen.split("\n").filter((row) => /^\s*›/.test(row)),
  }));
}

/** The CLI's screen, drawn from its raw output as it arrives. */
export function screenMirror(size: TerminalSize) {
  // The headless buffer is a proposed API.
  const terminal = new Terminal({ ...size, allowProposedApi: true });
  let drawn = Promise.resolve();
  return {
    draw(data: string) {
      drawn = new Promise((resolve) => terminal.write(data, resolve));
    },
    /** The screen once all output received so far is drawn. */
    async read(): Promise<string> {
      await drawn;
      const { active } = terminal.buffer;
      const rows: string[] = [];
      for (let row = 0; row < terminal.rows; row += 1)
        rows.push(active.getLine(active.viewportY + row)?.translateToString(true) ?? "");
      return rows.join("\n");
    },
    resize: (next: TerminalSize) => terminal.resize(next.cols, next.rows),
    dispose: () => terminal.dispose(),
  };
}
