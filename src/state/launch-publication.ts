/** Restore only unchanged files published by one failed launch (PRD §8.1, C-API-20). */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { fsyncDir, writePrivateFileAtomic } from "./files.ts";
import { currentFileOwner, readPrivateFile } from "./private-read.ts";
import { PublicationDirectory } from "./publication-directory.ts";
import { assertTrustedPublicationParent } from "./publication-parent-trust.ts";

type PublishedFile = {
  before: string | undefined;
  written: readonly (string | undefined)[];
  readonly directory: PublicationDirectory;
};

export class LaunchPublication {
  private readonly files = new Map<string, PublishedFile>();
  private readonly directories = new Map<string, PublicationDirectory>();

  /** Read and publish through the same held parent, including subsequent hook writes. */
  write(path: string, text: string): void {
    let entry = this.files.get(path);
    const parent = dirname(path);
    let directory = this.directories.get(parent);
    if (directory === undefined) {
      assertStatePath(path);
      assertTrustedPublicationParent(path);
      directory = new PublicationDirectory(path);
      this.directories.set(parent, directory);
    }
    let physical: string;
    let current: string | undefined;
    try {
      physical = directory.rollbackPath(path);
      current = read(physical);
    } catch (error) {
      this.releaseUnused(parent, directory);
      throw error;
    }
    entry ??= { before: current, written: [current], directory };
    // Preserve a predecessor's intervening record update across our next write.
    if (!entry.written.includes(current)) entry.before = current;
    // A failed write can leave either version: rename precedes directory fsync.
    entry.written = [current, text];
    this.files.set(path, entry);
    writePrivateFileAtomic(physical, text);
    entry.written = [text];
  }

  /** A predecessor's later write to `path` stands: rollback leaves it, whatever its bytes. */
  forget(path: string): void {
    const entry = this.files.get(path);
    if (entry === undefined) return;
    this.files.delete(path);
    this.releaseUnused(dirname(path), entry.directory);
  }

  clear(): void {
    for (const directory of this.directories.values()) directory.close();
    this.files.clear();
    this.directories.clear();
  }

  private releaseUnused(parent: string, directory: PublicationDirectory): void {
    if ([...this.files.keys()].some((file) => dirname(file) === parent)) return;
    directory.close();
    this.directories.delete(parent);
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
        this.files.delete(path);
        this.releaseUnused(dirname(path), entry.directory);
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
