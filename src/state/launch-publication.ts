/** Launch-owned physical snapshots, writes and rollback (PRD §8.1, C-API-20/61). */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { fsyncDir, writePrivateFileAtomic } from "./files.ts";
import { currentFileOwner, readPrivateFile } from "./private-read.ts";
import { PublicationDirectoryHold } from "./publication-directory.ts";
import { assertTrustedPublicationParent } from "./publication-parent-trust.ts";

type PublishedFile = {
  before: string | undefined;
  written: readonly (string | undefined)[];
  readonly directory: PublicationDirectoryHold;
};
type Snapshot = { readonly text: string | undefined; readonly directory: PublicationDirectoryHold };

export class LaunchPublication {
  private readonly files = new Map<string, PublishedFile>();
  private readonly directories = new Map<string, PublicationDirectoryHold>();
  private readonly originals = new Map<string, PublicationDirectoryHold>();
  private readonly snapshots = new Map<string, Snapshot>();

  private directory(path: string, expected?: PublicationDirectoryHold): PublicationDirectoryHold {
    const parent = dirname(path);
    const held = this.directories.get(parent);
    if (held !== undefined) return held;
    assertStatePath(path);
    assertTrustedPublicationParent(path);
    const original = this.originals.get(parent) ?? expected;
    const directory = new PublicationDirectoryHold(path, original);
    this.originals.set(parent, directory);
    this.directories.set(parent, directory);
    return directory;
  }

  /** Prefer the nearest pending generation holding this owner's original parent. */
  private authority(path: string, later: readonly LaunchPublication[]): PublicationDirectoryHold {
    const parent = dirname(path);
    const held = [...later].reverse().flatMap((publication) => {
      const directory = publication.directories.get(parent);
      return directory === undefined ? [] : [directory];
    });
    const original = this.originals.get(parent) ?? this.directory(path, held[0]);
    for (const directory of held) if (original.sameDirectory(directory)) return directory;
    return this.directory(path);
  }

  /** A new read always refreshes the snapshot paired with the next synchronous write. */
  read(path: string, later: readonly LaunchPublication[]): string | undefined {
    this.snapshots.delete(path);
    const directory = this.authority(path, later);
    const text = read(directory.pathInHeldDirectory(path));
    const snapshot = { text, directory };
    this.snapshots.set(path, snapshot);
    queueMicrotask(() => {
      if (this.snapshots.get(path) === snapshot) this.snapshots.delete(path);
    });
    return text;
  }

  write(path: string, text: string): PublicationDirectoryHold {
    const directory = this.directory(path);
    const physical = directory.pathInHeldDirectory(path);
    const snapshot = this.snapshots.get(path);
    this.snapshots.delete(path);
    const current = snapshot?.directory.sameDirectory(directory) ? snapshot.text : read(physical);
    const entry = this.files.get(path) ?? { before: current, written: [current], directory };
    if (!entry.written.includes(current)) entry.before = current;
    // Atomic rename may succeed before fsync fails; rollback must recognize either preimage.
    entry.written = [current, text];
    this.files.set(path, entry);
    writePrivateFileAtomic(physical, text);
    entry.written = [text];
    return directory;
  }

  /** Ordinary predecessor writes use matching pending holds, never a replacement path. */
  persist(
    path: string,
    text: string,
    later: readonly LaunchPublication[],
  ): PublicationDirectoryHold {
    const directory = this.authority(path, later);
    try {
      writePrivateFileAtomic(directory.pathInHeldDirectory(path), text);
      this.snapshots.delete(path);
      return directory;
    } finally {
      this.closeHolds();
    }
  }

  /** A rollback may be forgotten only for the physical parent actually updated. */
  forgetMatching(path: string, directory: PublicationDirectoryHold): void {
    const held = this.directories.get(dirname(path));
    if (held?.sameDirectory(directory)) {
      this.files.delete(path);
      this.snapshots.delete(path);
    }
  }

  private closeHolds(): void {
    for (const directory of this.directories.values()) directory.close();
    this.directories.clear();
  }

  /** Release transient writes and holds; retain identity for later post-commit persistence. */
  clearTransientPublicationState(): void {
    this.files.clear();
    this.snapshots.clear();
    this.closeHolds();
  }

  rollback(): void {
    let failed = false;
    for (const [path, entry] of this.files) {
      try {
        const physical = entry.directory.pathInHeldDirectory(path);
        if (entry.written.includes(read(physical))) {
          // Restoration can also fail after rename or unlink; retries accept that partial result.
          entry.written = [...new Set([...entry.written, entry.before])];
          if (entry.before === undefined) {
            rmSync(physical, { force: true });
            fsyncDir(dirname(physical));
          } else writePrivateFileAtomic(physical, entry.before);
        }
        this.files.delete(path);
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw elwoodError("state_corrupt", "Could not restore state after failed session startup.");
    this.clearTransientPublicationState();
  }
}

function read(path: string): string | undefined {
  assertStatePath(path);
  return readPrivateFile(path, currentFileOwner(), () =>
    elwoodError("state_corrupt", "Launch state is not a valid private file."),
  );
}
