/** Verify the saved rollout and anchor forward observation at its pre-launch EOF (C-STATE-15). */
import { type BigIntStats, closeSync, constants, fstatSync, openSync } from "node:fs";
import { isRecord } from "../../core/predicates.ts";
import { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import { type RangeRead, readRange, readTranscriptBytes } from "../../core/transcript/cursor-io.ts";
import { payloadOf } from "./payload.ts";

const maxHeaderBytes = 256 * 1024;
type FileIdentity = Readonly<Pick<BigIntStats, "dev" | "ino">>;

export function seedCodexResumeCursor(
  path: string,
  nativeSessionId: string,
): BoundedTranscriptCursor | undefined {
  try {
    return withOwnedRollout(path, (fd, stat) => {
      const prefix = readTranscriptBytes(fd, 0, maxHeaderBytes);
      const newline = prefix.indexOf(0x0a);
      if (newline === -1) return undefined;
      const header: unknown = JSON.parse(prefix.toString("utf8", 0, newline));
      if (!isRecord(header) || header["type"] !== "session_meta") return undefined;
      if (payloadOf(header)?.["id"] !== nativeSessionId) return undefined;
      return new CodexResumeCursor(path, stat);
    });
  } catch {
    return undefined;
  }
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
    if (!stat.isFile() || Number(stat.uid) !== process.getuid?.() || (stat.mode & 0o022n) !== 0n)
      throw staleRollout();
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
