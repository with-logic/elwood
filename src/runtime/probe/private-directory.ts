/**
 * A directory made for one probe's output, mode 0700 under the system temp directory, and its
 * removal however the probe ends (PRD §9.2, C-PERF-05).
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes a probe's private directory; `mkdtemp` makes it mode 0700. */
export function makePrivateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "elwood-probe-"));
}

/** Removes a probe's private directory as the probe settles, so it never throws. */
export function removePrivateDirectory(dir: string): void {
  try {
    // The probe's command is told the directory's path, so it may have made the directory,
    // or one it made inside it, unreadable. Elwood owns them, so it can open them again.
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // The command removed the directory itself.
  }
}

/** Gives `dir` and every directory under it back their owner's access. */
function unlock(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(join(dir, entry.name));
  }
}
