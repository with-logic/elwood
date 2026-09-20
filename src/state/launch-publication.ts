/** Restore only unchanged files published by one failed launch (PRD §8.1, C-API-20). */
import { rmSync } from "node:fs";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { writePrivateFileAtomic } from "./files.ts";
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
    try {
      for (const [path, entry] of this.files) {
        if (!entry.written.includes(read(path))) continue;
        if (entry.before === undefined) rmSync(path, { force: true });
        else writePrivateFileAtomic(path, entry.before);
      }
      this.clear();
    } catch {
      throw elwoodError("state_corrupt", "Could not restore state after failed session startup.");
    }
  }
}

function read(path: string): string | undefined {
  assertStatePath(path);
  return readPrivateFile(path, currentFileOwner(), () =>
    elwoodError("state_corrupt", "Launch state is not a valid private file."),
  );
}
