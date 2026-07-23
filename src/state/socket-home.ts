/**
 * Short-lived bridge socket homes kept outside stateDir.
 * Implements PRD §8.1 and C-STATE-12.
 */

import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * The ONE prefix an Elwood socket-home mkdtemp dir carries. Shared by creation
 * (runtime-paths) and the removal ownership check below, so the two can never drift
 * and silently refuse cleanup (leaking the directory).
 */
export const SOCKET_HOME_PREFIX = "elwood-";

/** Whether `socketPath` lives in a temp home this naming scheme minted (owned cleanup). */
export function ownsSocketHome(socketPath: string): boolean {
  return basename(dirname(socketPath)).startsWith(SOCKET_HOME_PREFIX);
}

/**
 * Removes the fresh temp home that held a launch's bridge socket. Only removes homes
 * this naming scheme created (an `elwood-`-prefixed mkdtemp dir); any other layout is
 * left untouched (the sessionDir removal covers a socket kept inside sessionDir).
 */
export function removeSocketHome(socketPath: string): void {
  if (!ownsSocketHome(socketPath)) return;
  rmSync(dirname(socketPath), { recursive: true, force: true });
}
