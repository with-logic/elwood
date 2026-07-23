/**
 * Short-lived bridge socket homes kept outside stateDir.
 * Implements PRD §8.1 and C-STATE-12.
 */

import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Removes the fresh temp home that held a launch's bridge socket. Only removes homes
 * this naming scheme created (an `elwood-`-prefixed mkdtemp dir); any other layout is
 * left untouched (the sessionDir removal covers a socket kept inside sessionDir).
 */
export function removeSocketHome(socketPath: string): void {
  const socketHome = dirname(socketPath);
  if (!basename(socketHome).startsWith("elwood-")) return;
  rmSync(socketHome, { recursive: true, force: true });
}
