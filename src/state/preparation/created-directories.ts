/** Record successful state-directory creations for bounded rollback (PRD §8.1, C-STATE-14). */
import { lstatSync, rmdirSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";
import { trustedRollbackParent } from "./rollback-parent.ts";

export type StateDirectoryCreationObserver = (path: string) => void;
type CreatedDirectory = { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint };

export class CreatedStateDirectories {
  private readonly directories = new Map<string, CreatedDirectory>();

  /** Called only after a single mkdir succeeded, never for an existing directory. */
  readonly record: StateDirectoryCreationObserver = (path) => {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid!())) return;
    // A recreated key belongs at its latest successful creation position.
    this.directories.delete(path);
    this.directories.set(path, { dev: entry.dev, ino: entry.ino, uid: entry.uid });
  };

  /**
   * Remove only empty, still-matching owned entries. Retained shared default roots and
   * sessions may already support another setup. Keep the first cleanup code without replacing
   * the setup failure that caused rollback.
   */
  remove(retainedDirectories: ReadonlySet<string> = new Set()): string | undefined {
    let failed: string | undefined;
    // Parents are created first even when native aliases spell them differently.
    const deepestFirst = [...this.directories].reverse();
    for (const [path, made] of deepestFirst) {
      if (retainedDirectories.has(path)) continue;
      try {
        if (!trustedRollbackParent(path)) continue;
        const current = lstatSync(path, { bigint: true });
        if (current.dev !== made.dev || current.ino !== made.ino || current.uid !== made.uid)
          continue;
        rmdirSync(path);
      } catch (error) {
        const code = errnoCode(error);
        if (code !== "ENOENT" && code !== "ENOTEMPTY") failed ??= code;
      }
    }
    return failed;
  }
}
