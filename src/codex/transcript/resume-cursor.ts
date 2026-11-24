/** Verify the saved rollout and anchor forward observation at its pre-launch EOF (C-STATE-15). */
import { type BigIntStats, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isRecord } from "../../core/predicates.ts";
import { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import { type RangeRead, readRange, readTranscriptBytes } from "../../core/transcript/cursor-io.ts";
import { payloadOf } from "./payload.ts";

const maxHeaderBytes = 256 * 1024;
const headerReadSize = 16 * 1024;
const groupOrOtherWriteBits = 0o022n;
type FileIdentity = Readonly<Pick<BigIntStats, "dev" | "ino">>;

/** Verify the first session_meta ID and baseline the rollout at its pre-launch EOF.
 * Missing, unsafe, malformed, or mismatched rollouts return undefined for hook-based discovery. */
export function seedCodexResumeCursor(
  path: string,
  nativeSessionId: string,
): BoundedTranscriptCursor | undefined {
  try {
    return withOwnedRollout(path, (fd, stat) => {
      const header = readRolloutHeader(fd);
      if (!isRecord(header) || header["type"] !== "session_meta") return undefined;
      if (payloadOf(header)?.["id"] !== nativeSessionId) return undefined;
      return new CodexResumeCursor(path, stat);
    });
  } catch {
    return undefined;
  }
}

function readRolloutHeader(fd: number): unknown {
  const bytes = Buffer.allocUnsafe(maxHeaderBytes);
  let offset = 0;
  while (offset < bytes.length) {
    const length = Math.min(bytes.length - offset, headerReadSize);
    const count = readSync(fd, bytes, offset, length, offset);
    if (count === 0) break;
    const end = offset + count;
    const lineEnd = bytes.subarray(offset, end).indexOf(0x0a);
    if (lineEnd !== -1) return JSON.parse(bytes.toString("utf8", 0, offset + lineEnd));
    offset = end;
  }
  return undefined;
}

class CodexResumeCursor extends BoundedTranscriptCursor {
  private readonly identity: FileIdentity;

  constructor(path: string, stat: BigIntStats) {
    super(path, { size: Number(stat.size) });
    this.identity = { dev: stat.dev, ino: stat.ino };
  }

  protected override liveSize(): number {
    return this.withVerifiedFile((_fd, size) => size);
  }

  protected override readRange(start: number, length: number): RangeRead {
    return readRange(this.path, start, length, (_path, from, bytes) =>
      this.withVerifiedFile((fd) => readTranscriptBytes(fd, from, bytes)),
    );
  }

  override remainingBytes(): number {
    return this.liveSize() - this.offset;
  }

  private withVerifiedFile<T>(use: (fd: number, size: number) => T): T {
    return withOwnedRollout(this.path, (fd, stat) => {
      // A saved locator authorizes appends to this file. A replacement or truncation must
      // not turn that authority into replay of older content.
      if (
        stat.dev !== this.identity.dev ||
        stat.ino !== this.identity.ino ||
        stat.size < this.offset
      )
        throw staleRollout();
      return use(fd, Number(stat.size));
    });
  }
}

function withOwnedRollout<T>(path: string, use: (fd: number, stat: BigIntStats) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const regularFile = stat.isFile();
    const ownedByCurrentUser = Number(stat.uid) === process.getuid?.();
    const writableByOthers = (stat.mode & groupOrOtherWriteBits) !== 0n;
    if (!(regularFile && ownedByCurrentUser) || writableByOthers) throw staleRollout();
    return use(fd, stat);
  } finally {
    closeSync(fd);
  }
}

function staleRollout(): Error {
  return Object.assign(new Error("The verified Codex rollout is no longer available."), {
    code: "ESTALE",
  });
}
