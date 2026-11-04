/** Pin a publication's parent across renames for rollback (PRD §8.1, C-API-61). */
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath } from "./directories.ts";
import { secureMkdir } from "./files.ts";

// A failed rollback may be abandoned by its caller; a live retry keeps its pin.
const abandoned = new FinalizationRegistry<number>(closeQuietly);

/** A read-only hold's disposal cannot reject publication or replace a validation failure. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* Never retry an ambiguous descriptor close. */
  }
}

export class PublicationDirectory {
  private readonly fd: number;
  private closed = false;
  private readonly identity: BigIntStats;
  private readonly parent: string;

  constructor(path: string) {
    this.parent = dirname(path);
    secureMkdir(this.parent);
    this.fd = openSync(
      this.parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.identity = fstatSync(this.fd, { bigint: true });
      if (this.identity.uid !== BigInt(process.getuid!())) throw unavailable();
    } catch (error) {
      closeQuietly(this.fd);
      throw error;
    }
    abandoned.register(this, this.fd, this);
  }

  /** Every macOS rollback operation stays anchored to the held directory inode. */
  rollbackPath(path: string): string {
    if (this.closed) throw unavailable();
    if (platform() !== "darwin") {
      if (this.matches(lstatSync(this.parent, { bigint: true }))) return path;
      throw unavailable();
    }
    const pinned = `/.vol/${this.identity.dev}/${this.identity.ino}`;
    assertStatePath(pinned);
    if (!this.matches(lstatSync(pinned, { bigint: true }))) throw unavailable();
    return join(pinned, basename(path));
  }

  close(): void {
    if (this.closed) return;
    // A failed close may already have released the number; never retry or finalize it.
    this.closed = true;
    abandoned.unregister(this);
    closeQuietly(this.fd);
  }

  private matches(current: BigIntStats): boolean {
    return (
      current.isDirectory() &&
      current.dev === this.identity.dev &&
      current.ino === this.identity.ino &&
      current.uid === this.identity.uid
    );
  }
}

function unavailable(): Error {
  return elwoodError("state_corrupt", "Could not locate the original launch state directory.");
}
