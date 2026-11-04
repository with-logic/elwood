/** Retain a verified directory descriptor across renames (PRD §8.1, C-STATE-01). */
import { type BigIntStats, constants, fstatSync, lstatSync, openSync } from "node:fs";
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

export class PublicationDirectoryHold {
  private readonly fd: number;
  private closed = false;
  private readonly identity: BigIntStats;
  private readonly parent: string;

  /**
   * Hold a published file's parent. Reopening an expected hold skips preparation so
   * identity is checked before a replacement directory could have its permissions changed.
   */
  constructor(publishedFilePath: string, expected?: PublicationDirectoryHold) {
    this.parent = dirname(publishedFilePath);
    this.fd =
      expected === undefined
        ? prepareAndOpenStateDirectory(this.parent, PRIVATE_STATE_MODE, "inside-parent")
        : openSync(this.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      this.identity = fstatSync(this.fd, { bigint: true });
      if (
        this.identity.uid !== BigInt(process.getuid!()) ||
        (expected !== undefined && !expected.sameDirectory(this))
      )
        throw unavailable();
    } catch (error) {
      closePublicationDirectory(this.fd);
      throw error;
    }
    abandoned.register(this, this.fd, this);
  }

  /** Resolve a published-file path through the held parent, preserving its filename. */
  pathInHeldDirectory(publishedFilePath: string): string {
    if (this.closed) throw unavailable();
    try {
      if (platform() !== "darwin") {
        if (this.matches(lstatSync(this.parent, { bigint: true }))) return publishedFilePath;
        throw unavailable();
      }
      // macOS VolFS addresses a directory by device/inode even after its parents move.
      const pinned = `/.vol/${this.identity.dev}/${this.identity.ino}`;
      assertStatePath(pinned);
      if (!this.matches(lstatSync(pinned, { bigint: true }))) throw unavailable();
      return join(pinned, basename(publishedFilePath));
    } catch {
      throw unavailable();
    }
  }

  /** Compare captured directory identities without exposing mutable metadata. */
  sameDirectory(other: PublicationDirectoryHold): boolean {
    return this.matches(other.identity);
  }

  /**
   * Idempotent disposal contains native close failures and reports them through the bounded
   * Node warning. Host callbacks follow Node's normal asynchronous error semantics.
   */
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
