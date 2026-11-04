/** Record successful state-directory creations for bounded rollback (PRD §8.1, C-STATE-14). */
import { lstatSync, rmdirSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";

export type StateDirectoryCreated = (path: string) => void;
type CreatedDirectory = { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint };

export class CreatedStateDirectories {
  private readonly directories = new Map<string, CreatedDirectory>();

  /** Called only after a single mkdir succeeded, never for an existing directory. */
  readonly record: StateDirectoryCreated = (path) => {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid!())) return;
    this.directories.set(path, { dev: entry.dev, ino: entry.ino, uid: entry.uid });
  };

  /**
   * Remove only empty, still-matching owned entries. Retained shared directories may
   * already support another setup. Keep the first cleanup code without replacing its cause.
   */
  remove(retainedDirectories: ReadonlySet<string> = new Set()): string | undefined {
    let failed: string | undefined;
    const deepestFirst = [...this.directories].sort(([a], [b]) => b.length - a.length);
    for (const [path, made] of deepestFirst) {
      if (retainedDirectories.has(path)) continue;
      try {
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
