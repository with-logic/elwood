/** Restore only unchanged files published by one failed launch (PRD §8.1, C-API-20). */
import { rmSync } from "node:fs";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { writePrivateFileAtomic } from "./files.ts";
import { currentFileOwner, readPrivateFile } from "./private-read.ts";

type PublishedFile = { before: string | undefined; written: string };

export class LaunchPublication {
  private readonly files = new Map<string, PublishedFile>();

  write(path: string, text: string): void {
    const entry = this.files.get(path);
    const current = read(path);
    if (entry) {
      // Preserve a predecessor's intervening record update across our next write.
      if (current !== entry.written) entry.before = current;
      entry.written = text;
    } else this.files.set(path, { before: current, written: text });
    // Record expected bytes before writing: rename may succeed before fsync fails.
    writePrivateFileAtomic(path, text);
  }

  clear(): void {
    this.files.clear();
  }

  rollback(): void {
    try {
      for (const [path, entry] of this.files) {
        if (read(path) !== entry.written) continue;
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
