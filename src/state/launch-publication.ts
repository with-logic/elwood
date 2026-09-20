/** Restore only unchanged files published by one failed launch (PRD §8.1, C-API-20). */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { fsyncDir, writePrivateFileAtomic } from "./files.ts";
import { currentFileOwner, readPrivateFile } from "./private-read.ts";

type PublishedFile = { before: string | undefined; written: readonly (string | undefined)[] };

export class LaunchPublication {
  private readonly files = new Map<string, PublishedFile>();

  write(path: string, text: string): void {
    const current = read(path);
    const entry = this.files.get(path) ?? { before: current, written: [current] };
    // Preserve a predecessor's intervening record update across our next write.
    if (!entry.written.includes(current)) entry.before = current;
    // A failed write can leave either version: rename precedes directory fsync.
    entry.written = [current, text];
    this.files.set(path, entry);
    writePrivateFileAtomic(path, text);
    entry.written = [text];
  }

  clear(): void {
    this.files.clear();
  }

  rollback(): void {
    let failed = false;
    for (const [path, entry] of this.files) {
      try {
        if (entry.written.includes(read(path))) {
          // A restoration can itself fail after rename/unlink but before directory fsync.
          entry.written = [...new Set([...entry.written, entry.before])];
          if (entry.before === undefined) {
            rmSync(path, { force: true });
            fsyncDir(dirname(path));
          } else writePrivateFileAtomic(path, entry.before);
        }
        this.files.delete(path);
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw elwoodError("state_corrupt", "Could not restore state after failed session startup.");
  }
}

function read(path: string): string | undefined {
  assertStatePath(path);
  return readPrivateFile(path, currentFileOwner(), () =>
    elwoodError("state_corrupt", "Launch state is not a valid private file."),
  );
}
