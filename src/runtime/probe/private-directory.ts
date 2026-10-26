/**
 * A directory made for one probe's output, mode 0700 under the system temp directory, and its
 * removal however the probe ends (PRD §9.2, C-PERF-05).
 */

import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { chmod, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes a probe's private directory; `mkdtemp` makes it mode 0700. */
export function makePrivateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "elwood-probe-"));
}

/**
 * Removes a probe's private directory, which holds at most `entries`, as the probe settles: an
 * unlink each and an `rmdir`, done at once. A directory the command changed, by what it made, locked,
 * or removed there, is removed off the event loop instead, however large a tree it left. Never
 * throws.
 */
export function removePrivateDirectory(dir: string, entries: readonly string[]): void {
  try {
    // `force`: setup that failed may not have made them.
    for (const entry of entries) rmSync(join(dir, entry), { force: true });
    rmdirSync(dir);
  } catch {
    void removeTree(dir);
  }
}

async function removeTree(dir: string): Promise<void> {
  try {
    // The command may have made the directory, or one it made inside it, unreadable. Elwood
    // owns them, so it can open them again.
    await unlock(dir);
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Mostly, the command removed the directory itself. Any other failure leaves it behind,
    // unreported: the probe has settled, and nothing reads a removal's outcome yet.
  }
}

/** Gives `dir` and every directory under it back their owner's access. */
async function unlock(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlock(join(dir, entry.name));
  }
}
