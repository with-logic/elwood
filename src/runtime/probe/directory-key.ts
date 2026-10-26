/**
 * The key a per-directory probe answer is cached under. Implements the per-directory caches of
 * PRD §9.2 (C-PERF-02).
 */

import { stat } from "node:fs/promises";

/**
 * `cwd` and which directory it names (device and inode), so a directory deleted and made again
 * at the same path is probed again rather than answered from the old one's result. A path that
 * can't be checked is keyed by itself: its probe fails, and a failed probe is not kept.
 */
export async function directoryKey(cwd: string): Promise<string> {
  try {
    const { dev, ino } = await stat(cwd, { bigint: true });
    return `${dev}:${ino}:${cwd}`;
  } catch {
    return cwd;
  }
}
