/**
 * Gives received terminal output a bounded drain before runtime disposal.
 * Implements PRD §9.4 and C-PERF-05; direct terminal.dispose() remains immediate.
 */

import type { ElwoodTerminal } from "../../terminal/headless.ts";

export async function drainAndDisposeTerminal(
  terminal: Pick<ElwoodTerminal, "settled" | "dispose">,
): Promise<void> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      terminal.settled(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    terminal.dispose();
  }
}
