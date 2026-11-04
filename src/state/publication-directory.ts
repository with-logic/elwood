/** Retain a verified directory descriptor across renames (PRD §8.1, C-STATE-01). */
import { type BigIntStats, fstatSync, lstatSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { elwoodError } from "../core/errors.ts";
import {
  assertStatePath,
  PRIVATE_STATE_MODE,
  prepareAndOpenStateDirectory,
} from "./directories.ts";
import { closePublicationDirectory } from "./publication/close.ts";

// A failed rollback may be abandoned by its caller; a live retry keeps its pin.
const abandoned = new FinalizationRegistry<number>(closePublicationDirectory);

export class PublicationDirectory {
  private readonly fd: number;
  private closed = false;
  private readonly identity: BigIntStats;
  private readonly parent: string;

  constructor(path: string) {
    this.parent = dirname(path);
    this.fd = prepareAndOpenStateDirectory(this.parent, PRIVATE_STATE_MODE, "inside-parent");
    try {
      this.identity = fstatSync(this.fd, { bigint: true });
      if (this.identity.uid !== BigInt(process.getuid!())) throw unavailable();
    } catch (error) {
      closePublicationDirectory(this.fd);
      throw error;
    }
    abandoned.register(this, this.fd, this);
  }

  /** Every macOS rollback operation stays anchored to the held directory inode. */
  pathInHeldDirectory(path: string): string {
    if (this.closed) throw unavailable();
    if (platform() !== "darwin") {
      if (this.matches(lstatSync(this.parent, { bigint: true }))) return path;
      throw unavailable();
    }
    // macOS VolFS addresses a directory by device/inode even after its parents move.
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
    closePublicationDirectory(this.fd);
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
