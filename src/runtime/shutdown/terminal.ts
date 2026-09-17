/**
 * Gives received terminal output a bounded drain before runtime disposal.
 * Implements PRD §9.4 and C-LIFE-12; direct terminal.dispose() remains immediate.
 */

import type { PtyProcess } from "../../pty/types.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

/** The whole drain, however many settle passes it takes, shares this one budget. */
export const terminalDrainTimeoutMs = 1_000;

export async function drainAndDisposeTerminal(
  terminal: Pick<ElwoodTerminal, "settled" | "dispose">,
  pty: Pick<PtyProcess, "onData">,
): Promise<void> {
  let received = 0;
  let drainTimer: NodeJS.Timeout | undefined;
  // Subscribed after the terminal's own listener, so each chunk counted here has
  // already been handed to the renderer that the next `settled()` pass awaits.
  const unsubscribe = pty.onData(() => {
    received += 1;
  });
  const quiescent = async (): Promise<void> => {
    // `settled()` covers only output received before it was called. Output that
    // arrives while that pass is pending would be discarded by disposal, so settle
    // again until one whole pass completes with nothing new received.
    for (let settledAt = -1; settledAt !== received; ) {
      settledAt = received;
      await terminal.settled();
    }
  };
  try {
    await Promise.race([
      quiescent(),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, terminalDrainTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(drainTimer);
    unsubscribe();
    terminal.dispose();
  }
}
