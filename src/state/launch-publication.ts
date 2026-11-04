/** Restore only unchanged files published by one failed launch (PRD §8.1, C-API-20). */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { fsyncDir, writePrivateFileAtomic } from "./files.ts";
import { currentFileOwner, readPrivateFile } from "./private-read.ts";
import { PublicationDirectory } from "./publication-directory.ts";

type PublishedFile = {
  before: string | undefined;
  written: readonly (string | undefined)[];
  readonly directory: PublicationDirectory;
};

export class LaunchPublication {
  private readonly files = new Map<string, PublishedFile>();

  /**
   * Publish `text` at `path`. A caller that has just read the file passes what it read as
   * `readText`, so a large file is not read again for the rollback preimage.
   */
  write(path: string, text: string, readText?: string): void {
    assertStatePath(path);
    const current = readText ?? readFile(path);
    const entry = this.files.get(path) ?? {
      before: current,
      written: [current],
      directory: new PublicationDirectory(path),
    };
    // Preserve a predecessor's intervening record update across our next write.
    if (!entry.written.includes(current)) entry.before = current;
    // A failed write can leave either version: rename precedes directory fsync.
    entry.written = [current, text];
    this.files.set(path, entry);
    writePrivateFileAtomic(path, text);
    entry.written = [text];
  }

  /** A predecessor's later write to `path` stands: rollback leaves it, whatever its bytes. */
  forget(path: string): void {
    this.files.get(path)?.directory.close();
    this.files.delete(path);
  }

  clear(): void {
    for (const entry of this.files.values()) entry.directory.close();
    this.files.clear();
  }

  rollback(): void {
    let failed = false;
    for (const [path, entry] of this.files) {
      try {
        const rollbackPath = entry.directory.rollbackPath(path);
        if (entry.written.includes(read(rollbackPath))) {
          // A restoration can itself fail after rename/unlink but before directory fsync.
          entry.written = [...new Set([...entry.written, entry.before])];
          if (entry.before === undefined) {
            rmSync(rollbackPath, { force: true });
            fsyncDir(dirname(rollbackPath));
          } else writePrivateFileAtomic(rollbackPath, entry.before);
        }
        entry.directory.close();
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
  return readFile(path);
}

function readFile(path: string): string | undefined {
  return readPrivateFile(path, currentFileOwner(), () =>
    elwoodError("state_corrupt", "Launch state is not a valid private file."),
  );
}
